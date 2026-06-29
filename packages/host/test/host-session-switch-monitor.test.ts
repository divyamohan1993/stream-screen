/**
 * Regression test for the monitor-switch track-cleanup bug (CODEX P1).
 *
 * When a viewer switches monitors, HostSession.switchMonitor() captures a new
 * video track and calls peer.replaceVideoTrack(newTrack). The core Peer shares
 * the EXACT SAME MediaStream object that was handed to attachStream(), and
 * replaceVideoTrack mutates it in place — inserting the new track and removing
 * the old ones. If switchMonitor then iterates the (now-mutated) stream's video
 * tracks and stop()s them, it stops the NEW replacement track, leaving the
 * RTCRtpSender with an ended track and freezing the viewer's video.
 *
 * This test reproduces that exact shared-stream mutation with fakes (no
 * Electron / native deps) and asserts the OLD track is stopped while the NEW
 * active track stays live and remains the sender's track. It fails before the
 * fix and passes after.
 *
 * All fakes live INSIDE the vi.mock factory (which is hoisted to the top of the
 * module) so there are no TDZ issues with hoisted class references, and they are
 * re-exported from the mocked module so the test body can construct streams and
 * reach the constructed Peer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stream-screen/core', () => {
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

  // Faithfully reproduces the behavior that triggers the bug: attachStream
  // stores the SAME stream object, and replaceVideoTrack mutates THAT shared
  // stream (swap sender track + sync video tracks) exactly like
  // packages/core/src/peer.ts.
  class FakePeer {
    localStream: FakeMediaStream | null = null;
    sender: { track: FakeMediaStreamTrack | null } = { track: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(): void {}
    on(): void {}
    onFileChunk(): void {}
    onControl(): void {}
    async start(): Promise<void> {}
    attachStream(s: FakeMediaStream): void {
      // Same reference HostSession holds as this.stream — crux of the bug.
      this.localStream = s;
      this.sender.track = s.getVideoTracks()[0] ?? null;
    }
    async replaceVideoTrack(track: FakeMediaStreamTrack): Promise<boolean> {
      this.sender.track = track;
      if (this.localStream) {
        for (const t of this.localStream.getVideoTracks()) {
          if (t !== track) this.localStream.removeTrack(t);
        }
        if (!this.localStream.getVideoTracks().includes(track)) {
          this.localStream.addTrack(track);
        }
      }
      return true;
    }
    sendControl(): void {}
    close(): void {}
  }

  class FakeSignalingClient {
    private handlers = new Map<string, Set<(m: { type: string }) => void>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string) {}
    async connect(): Promise<void> {}
    on(type: string, cb: (m: { type: string }) => void): void {
      let set = this.handlers.get(type);
      if (!set) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(cb);
    }
    off(type: string, cb: (m: { type: string }) => void): void {
      this.handlers.get(type)?.delete(cb);
    }
    // start() now awaits the server's `joined` ack; reply synchronously so the
    // host join handshake completes and start() resolves.
    join(): void {
      for (const cb of this.handlers.get('joined') ?? []) cb({ type: 'joined' });
    }
    close(): void {}
  }

  class FakeAdaptiveController {
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
    // Test-only helpers exposed through the mocked module.
    __FakeMediaStream: FakeMediaStream,
    __FakeMediaStreamTrack: FakeMediaStreamTrack,
  };
});

import { HostSession } from '../src/host-session.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// Bridge to the test-only fakes exported by the mock factory.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as {
  new (tracks?: unknown[]): FakeStream;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStreamTrack = (core as any).__FakeMediaStreamTrack as {
  new (kind: string): FakeTrack;
};

interface FakeTrack {
  kind: string;
  readyState: 'live' | 'ended';
  stopCalls: number;
}
interface FakeStream {
  getVideoTracks(): FakeTrack[];
}
interface FakePeerShape {
  localStream: FakeStream | null;
  sender: { track: FakeTrack | null };
}

function makeStream(): { stream: FakeStream; video: FakeTrack } {
  const video = new FakeMediaStreamTrack('video');
  const stream = new FakeMediaStream([video]);
  return { stream, video };
}

describe('HostSession.switchMonitor track cleanup (P1 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops the OLD video track but keeps the NEW active track live and attached', async () => {
    const initial = makeStream();
    const next = makeStream();

    const acquireStream = vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(initial.stream as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(next.stream as any);

    const session = new HostSession({
      signalingUrl: 'ws://test',
      code: '123456',
      hostName: 'test-host',
      sourceId: 'screen:0',
      onInput: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      acquireStream: acquireStream as any,
    });

    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape;
    expect(peer.sender.track).toBe(initial.video);

    await session.switchMonitor('screen:1');

    // OLD track was stopped.
    expect(initial.video.stopCalls).toBe(1);
    expect(initial.video.readyState).toBe('ended');

    // NEW active track was NOT stopped and stays live.
    expect(next.video.stopCalls).toBe(0);
    expect(next.video.readyState).toBe('live');

    // The new track remains the sender's track (viewer keeps receiving video).
    expect(peer.sender.track).toBe(next.video);
    expect(peer.sender.track?.readyState).toBe('live');

    // The shared stream record now carries exactly the new active track.
    expect(peer.localStream?.getVideoTracks()).toEqual([next.video]);

    session.stop();
  });

  it('keeps the adaptive loop usable across a switch (active source advances, track live)', async () => {
    const initial = makeStream();
    const next = makeStream();
    const acquireStream = vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(initial.stream as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(next.stream as any);

    const session = new HostSession({
      signalingUrl: 'ws://test',
      code: '123456',
      hostName: 'test-host',
      sourceId: 'screen:0',
      onInput: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      acquireStream: acquireStream as any,
    });

    await session.start();
    await session.switchMonitor('screen:1');

    expect(session.currentSourceId).toBe('screen:1');
    expect(next.video.readyState).toBe('live');

    session.stop();
  });
});
