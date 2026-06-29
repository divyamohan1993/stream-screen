/**
 * Tests for the HOST's ICE-server (STUN/TURN) integration — the opt-in
 * "connect from anywhere" path.
 *
 * The host obtains the ICE list to use at start() time with this precedence:
 *   1. the server-distributed list on the signaling `joined` ack (so BOTH peers
 *      negotiate against the SAME STUN/TURN config), else
 *   2. the LOCAL override from HostSessionOptions.iceServers (parsed in main from
 *      the STREAMSCREEN_ICE_SERVERS env), else
 *   3. [] — LAN-only, no ICE servers, behavior unchanged.
 *
 * It then constructs the per-viewer Peer with the resolved list (and exposes it
 * via `currentIceServers`).
 *
 * These are pure tests: a hoisted vi.mock provides controllable fakes (the Peer
 * records the iceServers it was constructed with; the signaling client can emit
 * a `joined` ack carrying iceServers). No Electron / native deps are touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stream-screen/core', () => {
  type Handler = (m: { type: string; message?: string; iceServers?: unknown }) => void;

  class FakeMediaStreamTrack {
    kind: string;
    readyState: 'live' | 'ended' = 'live';
    contentHint = '';
    stop(): void {
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

  /** Records the iceServers it was constructed with so the test can assert them. */
  class FakePeer {
    static lastIceServers: unknown = undefined;
    static constructCount = 0;
    localStream: FakeMediaStream | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts: any) {
      FakePeer.lastIceServers = opts?.iceServers;
      FakePeer.constructCount += 1;
    }
    onInput(): void {}
    on(): void {}
    onFileChunk(): void {}
    onControl(): void {}
    async start(): Promise<void> {}
    attachStream(s: FakeMediaStream): void {
      this.localStream = s;
    }
    sendControl(): void {}
    close(): void {}
  }

  /** Emits an armed `joined` reply (optionally carrying iceServers) on join(). */
  class FakeSignalingClient {
    static last: FakeSignalingClient | null = null;
    static nextReply: { type: string; message?: string; iceServers?: unknown } | null = null;
    private handlers = new Map<string, Set<Handler>>();
    private armedReply: { type: string; message?: string; iceServers?: unknown } | null = null;
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
      if (this.armedReply) {
        const reply = this.armedReply;
        this.armedReply = null;
        for (const cb of this.handlers.get(reply.type) ?? []) cb(reply);
      }
    }
    close(): void {}
  }

  class FakeAdaptiveController {
    constructor(..._args: unknown[]) {}
    update(): unknown {
      return { quality: 'auto', reason: 'HOLD' };
    }
  }
  class FakeFileTransferManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    onChunk(): void {}
  }

  // Faithful guard so HostSession can validate the ack's optional iceServers.
  const isIceServerList = (v: unknown): boolean =>
    Array.isArray(v) &&
    v.every(
      (s) =>
        s !== null &&
        typeof s === 'object' &&
        (typeof (s as { urls?: unknown }).urls === 'string' ||
          (Array.isArray((s as { urls?: unknown }).urls) &&
            ((s as { urls: unknown[] }).urls).every((u) => typeof u === 'string'))),
    );

  return {
    AdaptiveController: FakeAdaptiveController,
    Peer: FakePeer,
    SignalingClient: FakeSignalingClient,
    FileTransferManager: FakeFileTransferManager,
    isIceServerList,
    createSender: vi.fn(),
    KEY_MODS: { shift: 1, ctrl: 2, alt: 4, meta: 8 },
    CTRL_ALT_DEL: [],
    __FakeMediaStream: FakeMediaStream,
    __FakeMediaStreamTrack: FakeMediaStreamTrack,
    __FakePeer: FakePeer,
    __FakeSignalingClient: FakeSignalingClient,
  };
});

import { HostSession } from '../src/host-session.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (tracks?: unknown[]): unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStreamTrack = (core as any).__FakeMediaStreamTrack as { new (k: string): unknown };
const FakePeer = (core as { __FakePeer: { lastIceServers: unknown; constructCount: number } })
  .__FakePeer;
const FakeSignaling = (
  core as { __FakeSignalingClient: { nextReply: unknown; last: unknown } }
).__FakeSignalingClient;

function makeStream(): unknown {
  return new FakeMediaStream([new FakeMediaStreamTrack('video')]);
}

function makeSession(iceServers?: RTCIceServer[]): HostSession {
  return new HostSession({
    signalingUrl: 'ws://test',
    code: '123456',
    hostName: 'test-host',
    sourceId: 'screen:0',
    onInput: () => {},
    joinTimeoutMs: 50,
    iceServers,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: (async () => makeStream()) as any,
  });
}

describe('HostSession ICE-server resolution (connect-from-anywhere, opt-in)', () => {
  beforeEach(() => {
    FakePeer.lastIceServers = undefined;
    FakePeer.constructCount = 0;
    FakeSignaling.last = null;
    FakeSignaling.nextReply = null;
  });

  it('defaults to LAN-only ([]) when neither env override nor ack supplies a list', async () => {
    FakeSignaling.nextReply = { type: 'joined' };
    const session = makeSession();
    await session.start();

    expect(FakePeer.constructCount).toBe(1);
    expect(FakePeer.lastIceServers).toEqual([]);
    expect(session.currentIceServers).toEqual([]);
    session.stop();
  });

  it('uses the LOCAL env override (opts.iceServers) when the ack carries none', async () => {
    FakeSignaling.nextReply = { type: 'joined' };
    const override: RTCIceServer[] = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ];
    const session = makeSession(override);
    await session.start();

    expect(FakePeer.lastIceServers).toEqual(override);
    expect(session.currentIceServers).toEqual(override);
    session.stop();
  });

  it('PREFERS the server-distributed list from the joined ack over the local override', async () => {
    const ackList: RTCIceServer[] = [{ urls: 'turns:relay.example.net:5349', username: 'a', credential: 'b' }];
    FakeSignaling.nextReply = { type: 'joined', iceServers: ackList };
    const override: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];

    const session = makeSession(override);
    await session.start();

    // Ack wins so both peers match.
    expect(FakePeer.lastIceServers).toEqual(ackList);
    expect(session.currentIceServers).toEqual(ackList);
    session.stop();
  });

  it('falls back to the local override when the ack iceServers field is malformed', async () => {
    // A malformed iceServers (not an RTCIceServer[]) must be ignored, not crash.
    FakeSignaling.nextReply = { type: 'joined', iceServers: { not: 'an array' } };
    const override: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];

    const session = makeSession(override);
    await session.start();

    expect(FakePeer.lastIceServers).toEqual(override);
    session.stop();
  });

  it('an empty ack list does NOT override a non-empty local override', async () => {
    FakeSignaling.nextReply = { type: 'joined', iceServers: [] };
    const override: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];

    const session = makeSession(override);
    await session.start();

    // Empty ack means "server distributed nothing" => fall back to local override.
    expect(FakePeer.lastIceServers).toEqual(override);
    session.stop();
  });

  it('currentIceServers returns a defensive copy (callers cannot mutate internal state)', async () => {
    FakeSignaling.nextReply = { type: 'joined' };
    const override: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];
    const session = makeSession(override);
    await session.start();

    const first = session.currentIceServers;
    first.push({ urls: 'turn:evil.example.com:3478' });
    (first[0] as RTCIceServer).urls = 'stun:tampered:1';
    expect(session.currentIceServers).toEqual(override);
    session.stop();
  });
});
