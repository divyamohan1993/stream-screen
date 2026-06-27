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
});
