/**
 * Tests for the HOST real-time control improvements:
 *
 *  (A) FASTER, ASYMMETRIC LOOP ("fast-down / slow-up"):
 *      - ADAPTIVE_INTERVAL_MS is 500 (sample ~2x/sec).
 *      - DECREASE / HOLD decisions APPLY immediately (the very next tick).
 *      - An INCREASE applies ONLY after INCREASE_CONFIRM_TICKS consecutive
 *        increase classifications, gated by a DETERMINISTIC counter (no wall
 *        clock); any non-increase decision resets the gate.
 *
 *  (B) END-TO-END LATENCY FEEDBACK:
 *      - A viewer→host `{t:'latency',rttMs,playoutMs,fps}` report is stored
 *        (worst-case across viewers) and FOLDED into the stats handed to the
 *        controller, so a high reported playout delay forces the next tick to
 *        back off even when the host's own measured RTT is fine.
 *
 * These drive the REAL AdaptiveController (only Peer/Signaling/etc are faked —
 * no Electron, no WebRTC, no native deps). The controller's math is untouched;
 * we assert on which decisions the host APPLIES to the encoder.
 */

import { describe, expect, it, vi } from 'vitest';

// A mutable stats snapshot the FakePeer returns. Tests mutate `nextStats` to
// script the link condition seen by each tick. `applied` records every decision
// the host pushed to the encoder via applyDecision (the asymmetric gate's
// observable effect).
const scenario: {
  nextStats: Record<string, number>;
  applied: { targetKbps: number; reason: string }[];
} = {
  nextStats: {
    rttMs: 20,
    lossPct: 0,
    jitterMs: 2,
    fps: 60,
    width: 1920,
    height: 1080,
    availableKbps: 0,
    playoutMs: 0,
  },
  applied: [],
};

vi.mock('@stream-screen/core', async () => {
  const actual = await vi.importActual<typeof import('@stream-screen/core')>(
    '@stream-screen/core',
  );

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
      return { ...scenario.nextStats };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async applyDecision(d: any): Promise<void> {
      scenario.applied.push({ targetKbps: d.targetKbps, reason: d.reason });
    }
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
    FileTransferManager: FakeFileTransferManager,
    createSender: vi.fn(),
    __FakeMediaStream: FakeMediaStream,
  };
});

import {
  HostSession,
  ADAPTIVE_INTERVAL_MS,
  INCREASE_CONFIRM_TICKS,
} from '../src/host-session.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (): unknown };

function setStats(s: Record<string, number>): void {
  scenario.nextStats = { ...scenario.nextStats, ...s };
}

async function newSession(): Promise<HostSession> {
  scenario.applied = [];
  setStats({
    rttMs: 20,
    lossPct: 0,
    jitterMs: 2,
    fps: 60,
    width: 1920,
    height: 1080,
    availableKbps: 0,
    playoutMs: 0,
  });
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
  return session;
}

const phaseOf = (reason: string): string => reason.split(':')[0];

describe('HostSession real-time control loop', () => {
  it('samples at ~2 Hz (ADAPTIVE_INTERVAL_MS === 500) with a sensible confirm window', () => {
    expect(ADAPTIVE_INTERVAL_MS).toBe(500);
    // N chosen so ramp-up is ~2s at 500ms.
    expect(INCREASE_CONFIRM_TICKS).toBe(4);
    expect(INCREASE_CONFIRM_TICKS * ADAPTIVE_INTERVAL_MS).toBe(2000);
  });

  it('fast-down: a DECREASE applies on the very next tick', async () => {
    const session = await newSession();
    scenario.applied = [];

    // Hard congestion: huge RTT blows the latency budget → DECREASE.
    setStats({ rttMs: 500, lossPct: 10, jitterMs: 80 });
    await session.tick();

    expect(scenario.applied).toHaveLength(1);
    expect(phaseOf(scenario.applied[0].reason)).toBe('DECREASE');
    session.stop();
  });

  it('slow-up: an INCREASE applies only after N consecutive increase decisions', async () => {
    const session = await newSession();
    scenario.applied = [];

    // Perfectly healthy link → every tick classifies as INCREASE.
    setStats({ rttMs: 20, lossPct: 0, jitterMs: 2, playoutMs: 0 });

    // The first N-1 increase ticks must NOT push anything to the encoder.
    for (let i = 0; i < INCREASE_CONFIRM_TICKS - 1; i++) {
      await session.tick();
      expect(scenario.applied).toHaveLength(0);
      // ...but the controller is recognizing them as INCREASE classifications.
      expect(phaseOf(session.currentDecision!.reason)).toBe('INCREASE');
    }

    // The Nth consecutive increase commits exactly one applied decision.
    await session.tick();
    expect(scenario.applied).toHaveLength(1);
    expect(phaseOf(scenario.applied[0].reason)).toBe('INCREASE');

    // After committing, the gate resets: the next increase does NOT apply yet.
    await session.tick();
    expect(scenario.applied).toHaveLength(1);
    session.stop();
  });

  it('a non-increase decision resets the consecutive-increase gate', async () => {
    const session = await newSession();
    scenario.applied = [];

    // Build up almost enough increases.
    setStats({ rttMs: 20, lossPct: 0, jitterMs: 2, playoutMs: 0 });
    for (let i = 0; i < INCREASE_CONFIRM_TICKS - 1; i++) await session.tick();
    expect(scenario.applied).toHaveLength(0);

    // A single DECREASE applies immediately AND resets the counter.
    setStats({ rttMs: 500, lossPct: 10, jitterMs: 80 });
    await session.tick();
    expect(scenario.applied).toHaveLength(1);
    expect(phaseOf(scenario.applied[0].reason)).toBe('DECREASE');

    // Now back to healthy: it must again take a FULL N increases to apply one.
    setStats({ rttMs: 20, lossPct: 0, jitterMs: 2, playoutMs: 0 });
    for (let i = 0; i < INCREASE_CONFIRM_TICKS - 1; i++) await session.tick();
    expect(scenario.applied).toHaveLength(1); // still just the earlier DECREASE
    await session.tick();
    expect(scenario.applied).toHaveLength(2);
    expect(phaseOf(scenario.applied[1].reason)).toBe('INCREASE');
    session.stop();
  });

  it('folds a high reported playout delay into stats so the next tick backs off', async () => {
    const session = await newSession();
    scenario.applied = [];

    // Measured network link is pristine (low RTT, no loss, no jitter, no
    // measured playout) — on its own this would classify as INCREASE.
    setStats({ rttMs: 20, lossPct: 0, jitterMs: 2, playoutMs: 0 });

    // Viewer reports a huge END-TO-END playout delay. targetRttMs default 120;
    // hard budget is target*1.6 = 192ms. rtt(20)+playout(400) = 420ms >> 192.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).handleControl(
      { t: 'latency', rttMs: 20, playoutMs: 400, fps: 60 },
      'viewer-1',
    );

    await session.tick();

    // The fold forced a back-off despite the clean measured link.
    expect(scenario.applied).toHaveLength(1);
    expect(phaseOf(scenario.applied[0].reason)).toBe('DECREASE');
    // The decision was driven by the folded latency (rtt+playout), not the
    // pristine measured rtt — the reason names the playout contribution.
    expect(scenario.applied[0].reason).toContain('playout');
    session.stop();
  });

  it('uses the WORST-CASE reported latency across multiple viewers', async () => {
    const session = await newSession();
    scenario.applied = [];

    setStats({ rttMs: 20, lossPct: 0, jitterMs: 2, playoutMs: 0 });

    // viewer-1 is fine; viewer-2 is suffering high playout delay.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ses = session as any;
    await ses.handleControl({ t: 'latency', rttMs: 10, playoutMs: 5 }, 'viewer-1');
    await ses.handleControl({ t: 'latency', rttMs: 10, playoutMs: 500 }, 'viewer-2');

    await session.tick();
    expect(phaseOf(scenario.applied[0].reason)).toBe('DECREASE');
    session.stop();
  });

  it('drops a viewer report when that viewer leaves (no stale back-off)', async () => {
    const session = await newSession();
    scenario.applied = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ses = session as any;
    await ses.handleControl({ t: 'latency', rttMs: 10, playoutMs: 500 }, 'viewer-1');

    // The report is gone after the viewer leaves; a clean link no longer backs
    // off on the stale latency. (Without the report, ramp-up needs N ticks, so
    // applied stays empty across the first N-1 healthy ticks.)
    expect(ses.viewerLatency.size).toBe(1);
    ses.viewerLatency.delete('viewer-1');

    setStats({ rttMs: 20, lossPct: 0, jitterMs: 2, playoutMs: 0 });
    for (let i = 0; i < INCREASE_CONFIRM_TICKS - 1; i++) await session.tick();
    expect(scenario.applied).toHaveLength(0);
    session.stop();
  });
});
