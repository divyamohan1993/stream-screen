/**
 * Regression test for FINDING A (P2): HostSession.switchSource must update the
 * QUEUED source even when NO viewers are connected.
 *
 * When the room has no active viewer connections, peer.replaceVideoTrack()
 * returns FALSE (there are no RTCRtpSenders to swap yet). The OLD switchMonitor
 * code treated that as a hard no-op: it stopped the freshly-captured track and
 * returned WITHOUT updating this.stream / the Peer's stored localStream or
 * activeSourceId. So the dropdown appeared to accept the change, but the NEXT
 * viewer to connect (which replays the Peer's stored localStream) still got the
 * ORIGINAL default source.
 *
 * This test uses a FakePeer with NO senders (replaceVideoTrack => false) and a
 * shared FakeMediaStream object (the same object passed to attachStream, exactly
 * like the real Peer.localStream aliasing) and asserts that after switchSource:
 *   - activeSourceId advanced to the new source,
 *   - the stored stream now holds the NEW video track (so a subsequently
 *     attached sender / new viewer would get it),
 *   - the NEW track is NOT stopped (it is the active queued stream),
 *   - the OLD track IS stopped (no leak).
 *
 * No Electron / native deps — core is faked via the hoisted vi.mock factory.
 */

import { describe, expect, it, vi } from 'vitest';

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

  // A Peer with NO connected viewers: it stores the attached stream (aliasing
  // the very same object, as the real Peer does) but has NO senders, so
  // replaceVideoTrack finds nothing to swap and returns false WITHOUT mutating
  // localStream (mirrors the real `if (replaced && this.localStream)` guard).
  class FakePeerNoViewers {
    localStream: FakeMediaStream | null = null;
    replaceCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(): void {}
    on(): void {}
    onFileChunk(): void {}
    onControl(): void {}
    async start(): Promise<void> {}
    attachStream(s: FakeMediaStream): void {
      this.localStream = s;
    }
    async replaceVideoTrack(_track: FakeMediaStreamTrack): Promise<boolean> {
      this.replaceCalls += 1;
      return false; // no senders / no viewers
    }
    sendControl(): void {}
    close(): void {}
  }

  class FakeSignalingClient {
    joinCalls = 0;
    closeCalls = 0;
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
    join(): void {
      this.joinCalls += 1;
      for (const cb of this.handlers.get('joined') ?? []) cb({ type: 'joined' });
    }
    close(): void {
      this.closeCalls += 1;
    }
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
    Peer: FakePeerNoViewers,
    SignalingClient: FakeSignalingClient,
    FileTransferManager: FakeFileTransferManager,
    createSender: vi.fn(),
    __FakeMediaStream: FakeMediaStream,
    __FakeMediaStreamTrack: FakeMediaStreamTrack,
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

interface FakeTrack {
  kind: string;
  readyState: 'live' | 'ended';
  stopCalls: number;
}
interface FakeStream {
  getVideoTracks(): FakeTrack[];
}
interface FakePeerNoViewersShape {
  localStream: FakeStream | null;
  replaceCalls: number;
}

function makeStream(): { stream: FakeStream; video: FakeTrack } {
  const video = new FakeMediaStreamTrack('video');
  const stream = new FakeMediaStream([video]);
  return { stream, video };
}

describe('HostSession.switchSource with NO viewers connected (FINDING A)', () => {
  it('updates activeSourceId + stored stream to the NEW track even when replaceVideoTrack returns false', async () => {
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
    const peer = (session as any).peer as FakePeerNoViewersShape;
    expect(session.currentSourceId).toBe('screen:0');
    // Sanity: stored stream initially holds the original track.
    expect(peer.localStream?.getVideoTracks()).toEqual([initial.video]);

    await session.switchSource('screen:1');

    // The peer genuinely had no senders to swap.
    expect(peer.replaceCalls).toBe(1);

    // activeSourceId advanced even though no sender was replaced.
    expect(session.currentSourceId).toBe('screen:1');

    // The stored local stream (aliased by the Peer; replayed to future viewers)
    // now holds the NEW track and ONLY the new track.
    expect(peer.localStream?.getVideoTracks()).toEqual([next.video]);

    // The NEW track is NOT stopped — it is the active queued stream.
    expect(next.video.readyState).toBe('live');
    expect(next.video.stopCalls).toBe(0);

    // The OLD track IS stopped — no leak.
    expect(initial.video.readyState).toBe('ended');
    expect(initial.video.stopCalls).toBe(1);

    session.stop();
  });
});
