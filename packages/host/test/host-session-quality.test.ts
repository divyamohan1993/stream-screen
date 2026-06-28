/**
 * Regression test for the dropped quality-preset control message (CODEX P2,
 * Finding 5).
 *
 * The viewer toolbar sends `{t:'quality',preset}` over the control channel to
 * change stream quality (set_quality). Before the fix, HostSession.handleControl
 * let that message fall through to `default` — so it was acknowledged by the
 * protocol but NEVER applied: the host's AdaptiveController kept its default
 * 40 Mbps ceiling and the stream did not change. set_quality was a silent no-op.
 *
 * This test drives a real {@link AdaptiveController} (only Peer/Signaling are
 * faked — no Electron, no native deps, no WebRTC) through several adaptive ticks
 * on a perfectly healthy link (which makes the AIMD engine ramp UP toward its
 * ceiling), once per preset. It asserts the produced target bitrate is strictly
 * ordered low < balanced < high <= auto, i.e. the preset actually re-bounds the
 * adaptive engine. It fails before the fix (every preset yields the same ramp,
 * because the message is ignored) and passes after.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock ONLY the transport-y parts of core; keep the REAL AdaptiveController so
// the preset ceilings genuinely throttle the engine.
vi.mock('@stream-screen/core', async () => {
  const actual = await vi.importActual<typeof import('@stream-screen/core')>(
    '@stream-screen/core',
  );

  // A healthy-link stats snapshot: low RTT/loss/jitter with real signal, so the
  // controller's classify() chooses INCREASE and ramps toward its ceiling.
  const healthyStats = {
    rttMs: 20,
    lossPct: 0,
    jitterMs: 2,
    fps: 60,
    width: 1920,
    height: 1080,
    availableKbps: 0,
    outboundKbps: 0,
  };

  class FakePeer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(): void {}
    on(): void {}
    onFileChunk(): void {}
    onControl(): void {}
    async start(): Promise<void> {}
    attachStream(): void {}
    async replaceVideoTrack(): Promise<boolean> {
      return true;
    }
    sendControl(): void {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async getStats(): Promise<any> {
      return { ...healthyStats };
    }
    async applyDecision(): Promise<void> {}
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

  class FakeFileTransferManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    onChunk(): void {}
    onControl(): void {}
  }

  class FakeMediaStream {
    getTracks(): unknown[] {
      return [];
    }
    getVideoTracks(): unknown[] {
      return [];
    }
    getAudioTracks(): unknown[] {
      return [];
    }
  }

  return {
    ...actual,
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
    __FakeMediaStream: FakeMediaStream,
  };
});

import { HostSession, qualityBounds } from '../src/host-session.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';
import type { QualityPreset } from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (): unknown };

/**
 * Start a session, apply `preset`, then run enough healthy ticks for the AIMD
 * engine to saturate against the preset ceiling, and return the final target.
 */
async function rampedTargetFor(preset: QualityPreset): Promise<number> {
  const session = new HostSession({
    signalingUrl: 'ws://test',
    code: '123456',
    hostName: 'test-host',
    sourceId: 'screen:0',
    onInput: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: async () => new FakeMediaStream() as any,
  });
  await session.start();

  // Apply the preset exactly as an inbound control message would.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (session as any).handleControl({ t: 'quality', preset }, 'viewer-1');
  expect(session.currentPreset).toBe(preset);

  // Many ticks so the increase phase saturates against the ceiling.
  for (let i = 0; i < 200; i++) await session.tick();
  const target = session.currentDecision?.targetKbps ?? 0;
  session.stop();
  return target;
}

describe('HostSession quality preset handling (P2 regression)', () => {
  it('re-bounds the adaptive engine so lower presets cap to a lower target bitrate', async () => {
    const low = await rampedTargetFor('low');
    const balanced = await rampedTargetFor('balanced');
    const high = await rampedTargetFor('high');
    const auto = await rampedTargetFor('auto');

    // The preset actually changes quality: strictly increasing ceilings.
    expect(low).toBeLessThan(balanced);
    expect(balanced).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(auto);

    // And each saturated target respects its preset ceiling.
    expect(low).toBeLessThanOrEqual(qualityBounds('low').maxKbps);
    expect(balanced).toBeLessThanOrEqual(qualityBounds('balanced').maxKbps);
    expect(high).toBeLessThanOrEqual(qualityBounds('high').maxKbps);
  });

  it('treats a quality message as a real handler, not a default no-op', async () => {
    // 'low' must be DRAMATICALLY below 'auto' — proving the message was applied,
    // not ignored (which would make them identical ramps).
    const low = await rampedTargetFor('low');
    const auto = await rampedTargetFor('auto');
    expect(low).toBeLessThan(auto / 2);
  });

  it('exposes monotonically non-decreasing preset ceilings', () => {
    expect(qualityBounds('low').maxKbps).toBeLessThan(qualityBounds('balanced').maxKbps);
    expect(qualityBounds('balanced').maxKbps).toBeLessThan(qualityBounds('high').maxKbps);
    expect(qualityBounds('high').maxKbps).toBeLessThanOrEqual(qualityBounds('auto').maxKbps);
  });
});
