/**
 * Regression test for the native video sink lifetime bug (P2, session.ts:732).
 *
 * When the AI server runs on `@roamhq/wrtc`, tryNativeSink() creates an
 * `RTCVideoSink` and attaches an `onframe` callback that feeds screenshots.
 * BEFORE the fix the sink was held ONLY in a local variable, so once
 * tryNativeSink() returned the JS sink object (and its onframe closure) became
 * garbage-collectable. A GC could then silently stop frame delivery even though
 * the session stayed connected — screenshot/ocr_screen would then never get a
 * frame.
 *
 * The fix STORES the sink on the session instance (this.videoSink) so it stays
 * referenced for the session's lifetime, and disconnect() STOPS + CLEARS it so a
 * reconnect installs a fresh one.
 *
 * `@roamhq/wrtc` is an OPTIONAL dynamic import; here we mock it so the test runs
 * on any platform (including Linux without the native binary).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fake native RTCVideoSink that records construction, stop() and the track. */
class FakeRTCVideoSink {
  static instances: FakeRTCVideoSink[] = [];
  onframe: ((e: { frame: { width: number; height: number; data: Uint8Array } }) => void) | null =
    null;
  stopped = 0;
  readonly track: unknown;
  constructor(track: unknown) {
    this.track = track;
    FakeRTCVideoSink.instances.push(this);
  }
  stop(): void {
    this.stopped++;
  }
}

// Mock the optional native runtime so importing it inside tryNativeSink() yields
// our fake nonstandard.RTCVideoSink.
vi.mock('@roamhq/wrtc', () => ({
  nonstandard: { RTCVideoSink: FakeRTCVideoSink },
}));

import { RemoteDesktopSession } from '../src/session.js';

/** A valid 2x2 I420 frame (Y=4, U=1, V=1 bytes) so encodeI420ToPng succeeds. */
function makeI420Frame() {
  return { width: 2, height: 2, data: new Uint8Array([16, 16, 16, 16, 128, 128]) };
}

afterEach(() => {
  FakeRTCVideoSink.instances.length = 0;
});

describe('native video sink lifetime (P2 session.ts:732)', () => {
  it('RETAINS the sink on the session instance (not a GC-eligible local) and routes frames to screenshots', async () => {
    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });

    // Drive the private sink installer directly with a fake track.
    const track = { id: 'remote-video' };
    await (session as unknown as { tryNativeSink(t: unknown): Promise<void> }).tryNativeSink(track);

    // A native sink was constructed against our track.
    expect(FakeRTCVideoSink.instances).toHaveLength(1);
    const sink = FakeRTCVideoSink.instances[0];
    expect(sink.track).toBe(track);

    // THE FIX: the very sink instance is held on the session, so it cannot be
    // collected after tryNativeSink() returned. (Before the fix videoSink did
    // not exist / stayed null and the local sink was GC-eligible.)
    expect((session as unknown as { videoSink: unknown }).videoSink).toBe(sink);
    expect(sink.onframe).toBeTypeOf('function');

    // Frames delivered via the RETAINED sink reach screenshot().
    sink.onframe!({ frame: makeI420Frame() });

    // screenshot() requires a connection; force connected state for the assert.
    const internals = session as unknown as { connectedCode: string | null; peer: unknown };
    internals.connectedCode = '123456';
    internals.peer = { close() {} };
    const shot = await session.screenshot();
    expect(shot.mimeType).toBe('image/png');
    expect(shot.data.length).toBeGreaterThan(0);
  });

  it('disconnect() STOPS and CLEARS the retained sink so a reconnect makes a fresh one', async () => {
    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    await (session as unknown as { tryNativeSink(t: unknown): Promise<void> }).tryNativeSink({});

    const sink = FakeRTCVideoSink.instances[0];
    expect((session as unknown as { videoSink: unknown }).videoSink).toBe(sink);

    session.disconnect();

    // Native resources released and the reference dropped.
    expect(sink.stopped).toBe(1);
    expect(sink.onframe).toBeNull();
    expect((session as unknown as { videoSink: unknown }).videoSink).toBeNull();

    // A reconnect (re-install) creates a brand new sink, not the stopped one.
    await (session as unknown as { tryNativeSink(t: unknown): Promise<void> }).tryNativeSink({});
    expect(FakeRTCVideoSink.instances).toHaveLength(2);
    expect((session as unknown as { videoSink: unknown }).videoSink).toBe(
      FakeRTCVideoSink.instances[1],
    );
  });
});
