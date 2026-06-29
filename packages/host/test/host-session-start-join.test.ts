/**
 * Regression tests for two HOST start() bugs (P2):
 *
 *  FINDING A — "Withdraw the host room when capture fails": start() used to JOIN
 *  the signaling room BEFORE acquiring the capture stream, so any getUserMedia /
 *  acquire failure rejected start() while leaving the socket joined as a live
 *  host with NO media — a dead, advertised room viewers could still join.
 *
 *  FINDING B — "Wait for host join acknowledgement": start() never waited for the
 *  server's `joined` vs `error` reply, so a rejected join (e.g. `host-exists` for
 *  a duplicate code) still started capturing as though the room were ours.
 *
 * The fix REORDERS start() to acquire the stream FIRST, THEN join and AWAIT the
 * `joined` acknowledgement (per the shared signaling contract), ABORTING and
 * tearing down (stop the stream + close signaling/peer) on an `error`
 * (host-exists) or a join timeout. Only after a confirmed join does the adaptive
 * loop / capture pipeline start.
 *
 * These tests assert:
 *  (A) acquire failure  => start() rejects, signaling never left joined.
 *  (B) `error` host-exists => start() rejects, stream stopped, signaling closed,
 *      no capture loop started.
 *  (C) `joined`         => start() resolves and the session proceeds.
 *
 * All fakes live INSIDE the hoisted vi.mock factory (no TDZ on class refs) and
 * the controllable ones are re-exported so the test body can drive them. No
 * Electron / native deps are touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stream-screen/core', () => {
  type Handler = (m: { type: string; message?: string }) => void;

  class FakeMediaStreamTrack {
    kind: string;
    readyState: 'live' | 'ended' = 'live';
    enabled = true;
    contentHint = '';
    stopCalls = 0;
    stop(): void {
      this.stopCalls += 1;
      this.readyState = 'ended';
    }
    constructor(kind: string) {
      this.kind = kind;
    }
  }

  class FakeMediaStream {
    private tracks: FakeMediaStreamTrack[];
    constructor(tracks: FakeMediaStreamTrack[] = []) {
      this.tracks = [...tracks];
    }
    getTracks(): FakeMediaStreamTrack[] {
      return [...this.tracks];
    }
    getVideoTracks(): FakeMediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'video');
    }
    getAudioTracks(): FakeMediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
    addTrack(t: FakeMediaStreamTrack): void {
      if (!this.tracks.includes(t)) this.tracks.push(t);
    }
    removeTrack(t: FakeMediaStreamTrack): void {
      this.tracks = this.tracks.filter((x) => x !== t);
    }
  }

  class FakePeer {
    localStream: FakeMediaStream | null = null;
    attachCalls = 0;
    startCalls = 0;
    closeCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(): void {}
    on(): void {}
    onFileChunk(): void {}
    onControl(): void {}
    async start(): Promise<void> {
      this.startCalls += 1;
    }
    attachStream(s: FakeMediaStream): void {
      this.localStream = s;
      this.attachCalls += 1;
    }
    sendControl(): void {}
    close(): void {
      this.closeCalls += 1;
    }
  }

  /**
   * Controllable signaling fake. Records join()/close() and lets a test fire the
   * server's `joined` / `error` reply (synchronously on join, or queued before).
   */
  class FakeSignalingClient {
    static last: FakeSignalingClient | null = null;
    /**
     * A reply the NEXT-constructed client should auto-emit when its join() is
     * called. Set by the test BEFORE start() so the reply deterministically
     * races ahead of (i.e. fires synchronously inside) join(). Consumed once.
     */
    static nextReply: { type: string; message?: string } | null = null;
    joinCalls = 0;
    closeCalls = 0;
    private handlers = new Map<string, Set<Handler>>();
    /** A reply to emit on the next join(), if armed. */
    private armedReply: { type: string; message?: string } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string) {
      FakeSignalingClient.last = this;
      if (FakeSignalingClient.nextReply) {
        this.armedReply = FakeSignalingClient.nextReply;
        FakeSignalingClient.nextReply = null;
      }
    }
    async connect(): Promise<void> {}
    on(type: string, cb: Handler): void {
      let set = this.handlers.get(type);
      if (!set) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(cb);
    }
    off(type: string, cb: Handler): void {
      this.handlers.get(type)?.delete(cb);
    }
    join(): void {
      this.joinCalls += 1;
      if (this.armedReply) {
        const reply = this.armedReply;
        this.armedReply = null;
        this.emit(reply);
      }
    }
    close(): void {
      this.closeCalls += 1;
    }
    /** Arm a reply to be emitted synchronously when join() is next called. */
    armReply(m: { type: string; message?: string }): void {
      this.armedReply = m;
    }
    /** Emit a server message to all subscribers of its type. */
    emit(m: { type: string; message?: string }): void {
      for (const cb of this.handlers.get(m.type) ?? []) cb(m);
    }
  }

  class FakeAdaptiveController {
    constructor(..._args: unknown[]) {}
    update(): unknown {
      return { quality: 'auto' };
    }
  }

  class FakeFileTransferManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    onChunk(): void {}
    onControl(): void {}
  }

  return {
    AdaptiveController: FakeAdaptiveController,
    Peer: FakePeer,
    SignalingClient: FakeSignalingClient,
    // Real-shaped guard so HostSession.start can validate the `joined` ack's
    // optional iceServers (ICE config integration). Empty/absent => LAN-only.
    isIceServerList: (v: unknown): boolean =>
      Array.isArray(v) &&
      v.every(
        (s) =>
          s !== null &&
          typeof s === 'object' &&
          (typeof (s as { urls?: unknown }).urls === 'string' ||
            (Array.isArray((s as { urls?: unknown }).urls) &&
              ((s as { urls: unknown[] }).urls).every((u) => typeof u === 'string'))),
      ),
    FileTransferManager: FakeFileTransferManager,
    createSender: vi.fn(),
    KEY_MODS: { shift: 1, ctrl: 2, alt: 4, meta: 8 },
    CTRL_ALT_DEL: [],
    __FakeMediaStream: FakeMediaStream,
    __FakeMediaStreamTrack: FakeMediaStreamTrack,
    __FakeSignalingClient: FakeSignalingClient,
  };
});

import { HostSession } from '../src/host-session.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (tracks?: unknown[]): FakeStream };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStreamTrack = (core as any).__FakeMediaStreamTrack as {
  new (kind: string): FakeTrack;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeSignaling = (core as any).__FakeSignalingClient as {
  last: FakeSignalingShape | null;
  nextReply: { type: string; message?: string } | null;
};

interface FakeTrack {
  kind: string;
  readyState: 'live' | 'ended';
  stopCalls: number;
}
interface FakeStream {
  getVideoTracks(): FakeTrack[];
  getTracks(): FakeTrack[];
}
interface FakeSignalingShape {
  joinCalls: number;
  closeCalls: number;
}
interface FakePeerShape {
  attachCalls: number;
  closeCalls: number;
}

function makeStream(): { stream: FakeStream; video: FakeTrack } {
  const video = new FakeMediaStreamTrack('video');
  const stream = new FakeMediaStream([video]);
  return { stream, video };
}

function makeSession(
  acquireStream: (...args: unknown[]) => Promise<unknown>,
): HostSession {
  return new HostSession({
    signalingUrl: 'ws://test',
    code: '123456',
    hostName: 'test-host',
    sourceId: 'screen:0',
    onInput: () => {},
    // Keep the handshake timeout short so a non-acknowledging server can be
    // exercised quickly if ever needed; the host fakes reply synchronously here.
    joinTimeoutMs: 50,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: acquireStream as any,
  });
}

describe('HostSession.start join handshake + capture-first ordering (P2 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeSignaling.last = null;
    FakeSignaling.nextReply = null;
  });

  it('(A) acquire/getUserMedia failure rejects start() and NEVER leaves signaling joined', async () => {
    const acquireStream = vi.fn().mockRejectedValue(new Error('getUserMedia: permission denied'));

    const session = makeSession(acquireStream);

    await expect(session.start()).rejects.toThrow(/permission denied/);

    // Acquire was attempted...
    expect(acquireStream).toHaveBeenCalledTimes(1);

    // ...but because acquire happens BEFORE joining, the host must never have
    // joined a room. Either no signaling client was constructed, or if one was,
    // join() was never called and it was closed — no dangling live host.
    const sig = FakeSignaling.last;
    if (sig) {
      expect(sig.joinCalls).toBe(0);
      expect(sig.closeCalls).toBeGreaterThanOrEqual(1);
    }

    // started flag reset so the session can be retried.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).started).toBe(false);
  });

  it('(B) signaling replies error host-exists: start() rejects, stream stopped, signaling closed, no capture loop', async () => {
    const { stream, video } = makeStream();
    const acquireStream = vi.fn().mockResolvedValue(stream);

    const session = makeSession(acquireStream);

    // Arm the server (the about-to-be-constructed client) to reject the host join
    // with host-exists the moment join() is called — a duplicate STREAMSCREEN_CODE
    // already held by a live host. Set BEFORE start() so the reply fires
    // synchronously inside join(), with no timing race.
    FakeSignaling.nextReply = { type: 'error', message: 'host-exists' };

    await expect(session.start()).rejects.toThrow(/host-exists/);

    const sig = FakeSignaling.last!;
    expect(sig.joinCalls).toBe(1);
    // Signaling was closed (withdrawn) — no live advertised room remains.
    expect(sig.closeCalls).toBeGreaterThanOrEqual(1);

    // The acquired stream was stopped on abort (no leaked capture).
    expect(video.stopCalls).toBeGreaterThanOrEqual(1);
    expect(video.readyState).toBe('ended');

    // The peer was closed and media was NEVER attached (no capture loop started).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape | null;
    expect(peer).toBeNull();
    // No adaptive loop timer is running.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).adaptiveTimer).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).started).toBe(false);
  });

  it('(C) signaling replies joined: start() resolves and the session proceeds (media attached, loop running)', async () => {
    const { stream } = makeStream();
    const acquireStream = vi.fn().mockResolvedValue(stream);

    const session = makeSession(acquireStream);

    // Acknowledge the host join the moment join() is called.
    FakeSignaling.nextReply = { type: 'joined' };

    await expect(session.start()).resolves.toBeUndefined();

    const sig = FakeSignaling.last!;
    expect(sig.joinCalls).toBe(1);
    expect(sig.closeCalls).toBe(0);

    // Media attached AFTER the confirmed join, and the adaptive loop is running.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape;
    expect(peer.attachCalls).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).adaptiveTimer).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).started).toBe(true);

    session.stop();
  });
});
