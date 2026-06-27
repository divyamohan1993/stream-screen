/**
 * Regression test for HostSession.switchSource (P2 host-exists race).
 *
 * The host operator changing the capture source must NOT leave and rejoin the
 * signaling room. switchSource reuses the in-place re-capture +
 * peer.replaceVideoTrack mechanism (same as switchMonitor), so:
 *   - signaling.join() is called EXACTLY ONCE (the original start) — never again,
 *   - the signaling socket is never closed across the switch (stays advertised),
 *   - the peer's sender adopts the NEW source's video track.
 *
 * Before the fix the renderer stopped the session (closing the socket) and
 * started a new one (a SECOND join with the same code), which the server rejects
 * as host-exists. This asserts the in-place path does neither. No Electron /
 * native deps — core is faked via the hoisted vi.mock factory.
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
    Peer: FakePeer,
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
}
interface FakeStream {
  getVideoTracks(): FakeTrack[];
}
interface FakeSignalingShape {
  joinCalls: number;
  closeCalls: number;
}
interface FakePeerShape {
  sender: { track: FakeTrack | null };
}

function makeStream(): { stream: FakeStream; video: FakeTrack } {
  const video = new FakeMediaStreamTrack('video');
  const stream = new FakeMediaStream([video]);
  return { stream, video };
}

describe('HostSession.switchSource (P2 in-place, no rejoin)', () => {
  it('switches source in place: one join, socket never closed, new track attached', async () => {
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
    const signaling = (session as any).signaling as FakeSignalingShape;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape;
    expect(signaling.joinCalls).toBe(1);
    expect(signaling.closeCalls).toBe(0);
    expect(peer.sender.track).toBe(initial.video);

    await session.switchSource('screen:1');

    // No second join (no host-exists race) and the socket stayed open/advertised.
    expect(signaling.joinCalls).toBe(1);
    expect(signaling.closeCalls).toBe(0);

    // The active source advanced and the new track is attached to the sender.
    expect(session.currentSourceId).toBe('screen:1');
    expect(peer.sender.track).toBe(next.video);
    expect(next.video.readyState).toBe('live');

    session.stop();
  });

  it('is a no-op when the requested source is already active (no re-capture)', async () => {
    const initial = makeStream();
    const acquireStream = vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(initial.stream as any);

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
    expect(acquireStream).toHaveBeenCalledTimes(1);

    await session.switchSource('screen:0');

    // Same source => no second acquire, source unchanged.
    expect(acquireStream).toHaveBeenCalledTimes(1);
    expect(session.currentSourceId).toBe('screen:0');

    session.stop();
  });
});
