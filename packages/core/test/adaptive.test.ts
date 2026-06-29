import { describe, it, expect } from 'vitest';
import { AdaptiveController } from '../src/adaptive.js';
import type { AdaptiveStats } from '../src/protocol.js';

function stats(p: Partial<AdaptiveStats>): AdaptiveStats {
  return {
    rttMs: 30,
    lossPct: 0,
    jitterMs: 2,
    availableKbps: 0,
    fps: 60,
    width: 1920,
    height: 1080,
    ts: 0,
    ...p,
  };
}

describe('AdaptiveController', () => {
  it('starts conservative and ramps up on a healthy link', () => {
    const c = new AdaptiveController();
    const good = stats({ rttMs: 20, lossPct: 0, jitterMs: 1 });
    const first = c.update(good);
    let prev = first.targetKbps;
    for (let i = 0; i < 20; i++) {
      const d = c.update(good);
      expect(d.targetKbps).toBeGreaterThanOrEqual(prev);
      prev = d.targetKbps;
      expect(d.reason).toContain('INCREASE');
    }
    // Should have climbed well above the conservative start.
    expect(prev).toBeGreaterThan(first.targetKbps);
  });

  it('backs off fast on high packet loss', () => {
    const c = new AdaptiveController();
    // climb first
    for (let i = 0; i < 10; i++) c.update(stats({ rttMs: 20, lossPct: 0 }));
    const before = c.update(stats({ rttMs: 20, lossPct: 0 })).targetKbps;
    const d = c.update(stats({ rttMs: 20, lossPct: 12 }));
    expect(d.targetKbps).toBeLessThan(before);
    expect(d.reason).toContain('DECREASE');
    expect(d.reason).toContain('loss');
  });

  it('backs off on high RTT', () => {
    const c = new AdaptiveController({ targetRttMs: 100 });
    for (let i = 0; i < 10; i++) c.update(stats({ rttMs: 30 }));
    const before = c.update(stats({ rttMs: 30 })).targetKbps;
    const d = c.update(stats({ rttMs: 400 }));
    expect(d.targetKbps).toBeLessThan(before);
    expect(d.reason).toContain('rtt');
  });

  it('backs off on jitter spikes', () => {
    const c = new AdaptiveController();
    for (let i = 0; i < 10; i++) c.update(stats({ jitterMs: 2 }));
    const before = c.update(stats({ jitterMs: 2 })).targetKbps;
    const d = c.update(stats({ jitterMs: 80 }));
    expect(d.targetKbps).toBeLessThan(before);
    expect(d.reason).toContain('jitter');
  });

  it('holds steady in the ambiguous region', () => {
    const c = new AdaptiveController({ targetRttMs: 100 });
    const before = c.update(stats({ rttMs: 30 })).targetKbps;
    // mild loss between LOW and HIGH, rtt under hard threshold -> HOLD
    const d = c.update(stats({ rttMs: 120, lossPct: 3 }));
    expect(d.reason).toContain('HOLD');
    expect(d.targetKbps).toBe(before);
  });

  it('clamps to [minKbps, maxKbps]', () => {
    const c = new AdaptiveController({ minKbps: 500, maxKbps: 2000 });
    // ramp hard
    let d = c.update(stats({ rttMs: 5, lossPct: 0, jitterMs: 0 }));
    for (let i = 0; i < 200; i++) d = c.update(stats({ rttMs: 5, lossPct: 0, jitterMs: 0 }));
    expect(d.targetKbps).toBeLessThanOrEqual(2000);
    // crash hard
    for (let i = 0; i < 200; i++) d = c.update(stats({ lossPct: 50, rttMs: 1000 }));
    expect(d.targetKbps).toBeGreaterThanOrEqual(500);
  });

  it('respects measured available bitrate headroom on increase', () => {
    const c = new AdaptiveController({ minKbps: 300, maxKbps: 40000 });
    let d = c.update(stats({ rttMs: 10, availableKbps: 1000 }));
    for (let i = 0; i < 50; i++) d = c.update(stats({ rttMs: 10, availableKbps: 1000 }));
    // Should not blow far past the reported ~1000kbps headroom.
    expect(d.targetKbps).toBeLessThanOrEqual(1100);
  });

  it('is deterministic for identical input sequences', () => {
    const seq = [
      stats({ rttMs: 20 }),
      stats({ rttMs: 20 }),
      stats({ lossPct: 10 }),
      stats({ rttMs: 20 }),
      stats({ jitterMs: 60 }),
    ];
    const a = new AdaptiveController();
    const b = new AdaptiveController();
    const ra = seq.map((s) => a.update(s));
    const rb = seq.map((s) => b.update(s));
    expect(ra).toEqual(rb);
  });

  it('derives lower framerate and downscale at low bitrate', () => {
    const c = new AdaptiveController({ minKbps: 300, maxKbps: 40000 });
    let d = c.update(stats({ lossPct: 50, rttMs: 1000 }));
    for (let i = 0; i < 50; i++) d = c.update(stats({ lossPct: 50, rttMs: 1000 }));
    expect(d.maxFramerate).toBeLessThanOrEqual(30);
    expect(d.scaleResolutionDownBy).toBeGreaterThan(1);
  });

  it('rejects invalid option bounds', () => {
    expect(() => new AdaptiveController({ minKbps: 0 })).toThrow();
    expect(() => new AdaptiveController({ minKbps: 1000, maxKbps: 500 })).toThrow();
    expect(() => new AdaptiveController({ targetRttMs: 0 })).toThrow();
  });

  describe('end-to-end realtime latency (playoutMs)', () => {
    it('backs off when receiver playout pushes realtime latency over the hard budget even with low network rtt', () => {
      const c = new AdaptiveController({ targetRttMs: 100 });
      // Climb on a clean link (network rtt low, no playout).
      for (let i = 0; i < 10; i++) c.update(stats({ rttMs: 20 }));
      const before = c.update(stats({ rttMs: 20 })).targetKbps;
      // Network rtt alone (20ms) is well under hard budget (100*1.6 = 160ms),
      // but receiver-side playout adds 200ms -> realtime 220ms > 160ms.
      const d = c.update(stats({ rttMs: 20, playoutMs: 200 }));
      expect(d.targetKbps).toBeLessThan(before);
      expect(d.reason).toContain('DECREASE');
      expect(d.reason).toContain('rtt');
      // Reason should surface the playout breakdown.
      expect(d.reason).toContain('playout');
    });

    it('does NOT back off on the same network rtt when playout is zero (proves playout caused it)', () => {
      const c = new AdaptiveController({ targetRttMs: 100 });
      for (let i = 0; i < 10; i++) c.update(stats({ rttMs: 20 }));
      const before = c.update(stats({ rttMs: 20 })).targetKbps;
      // Same low network rtt, no playout -> realtime 20ms, healthy -> INCREASE.
      const d = c.update(stats({ rttMs: 20, playoutMs: 0 }));
      expect(d.targetKbps).toBeGreaterThanOrEqual(before);
      expect(d.reason).toContain('INCREASE');
    });

    it('suppresses increase when playout keeps realtime latency above target (but under hard budget)', () => {
      const c = new AdaptiveController({ targetRttMs: 100 });
      // Establish a baseline.
      const before = c.update(stats({ rttMs: 20 })).targetKbps;
      // Network rtt 20ms (< target 100), playout 90ms -> realtime 110ms.
      // 110 >= target (100) so INCREASE is suppressed, but 110 < hard (160) so
      // not a DECREASE either -> HOLD steady.
      const d = c.update(stats({ rttMs: 20, playoutMs: 90 }));
      expect(d.reason).toContain('HOLD');
      expect(d.targetKbps).toBe(before);
    });

    it('folds playout severity into the multiplicative back-off (heavier playout = harder cut)', () => {
      const mild = new AdaptiveController({ targetRttMs: 100 });
      const severe = new AdaptiveController({ targetRttMs: 100 });
      for (let i = 0; i < 10; i++) {
        mild.update(stats({ rttMs: 20 }));
        severe.update(stats({ rttMs: 20 }));
      }
      // Same warmed-up bitrate on both.
      const mBefore = mild.update(stats({ rttMs: 20 })).targetKbps;
      const sBefore = severe.update(stats({ rttMs: 20 })).targetKbps;
      expect(mBefore).toBe(sBefore);
      const mAfter = mild.update(stats({ rttMs: 20, playoutMs: 170 })).targetKbps; // realtime 190
      const sAfter = severe.update(stats({ rttMs: 20, playoutMs: 400 })).targetKbps; // realtime 420
      // Heavier playout -> larger severity -> smaller multiplier -> lower result.
      expect(sAfter).toBeLessThan(mAfter);
    });

    it('zero/absent playout is byte-identical to omitting the field entirely', () => {
      const seq = [
        stats({ rttMs: 20 }),
        stats({ rttMs: 20 }),
        stats({ rttMs: 200 }),
        stats({ rttMs: 20 }),
        stats({ jitterMs: 60 }),
        stats({ lossPct: 10 }),
      ];
      const a = new AdaptiveController();
      const b = new AdaptiveController();
      const ra = seq.map((s) => a.update(s)); // playoutMs absent
      const rb = seq.map((s) => b.update({ ...s, playoutMs: 0 })); // playoutMs explicit 0
      expect(ra).toEqual(rb);
    });
  });
});
