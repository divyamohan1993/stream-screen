import { test, expect } from '@playwright/test';

/**
 * Verifies the auto-negotiate-lag engine (AdaptiveController) inside a real
 * browser, driving the exact bundled core the host page uses. We feed it
 * synthetic AdaptiveStats sequences and assert the decisions:
 *   - a healthy link ramps the bitrate UP additively,
 *   - injected loss / high RTT / jitter backs the bitrate OFF,
 *   - decisions stay clamped within [minKbps, maxKbps] and framerate/scale are
 *     sane and monotonic with bitrate.
 *
 * Running this in-page (rather than as a node unit test) proves the browser
 * bundle of the engine behaves identically to the source.
 */

// A blank page is enough; we only need the bundled module to load.
const PAGE = '/host-page.html?code=000001';

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __host?: unknown }).__host !== undefined);
});

test('healthy link ramps the bitrate up', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const core = await import('./core.bundle.js');
    const ctrl = new core.AdaptiveController({ minKbps: 300, maxKbps: 40000, targetRttMs: 120 });
    const mk = (over: Partial<import('@stream-screen/core').AdaptiveStats>) => ({
      rttMs: 20,
      lossPct: 0,
      jitterMs: 2,
      availableKbps: 50000,
      fps: 60,
      width: 1920,
      height: 1080,
      ts: Date.now(),
      ...over,
    });
    const kbps: number[] = [];
    for (let i = 0; i < 10; i++) {
      kbps.push(ctrl.update(mk({})).targetKbps);
    }
    return kbps;
  });

  // Strictly increasing while there is headroom.
  for (let i = 1; i < result.length; i++) {
    expect(result[i]).toBeGreaterThan(result[i - 1]);
  }
  // And it actually grew meaningfully from the conservative start.
  expect(result[result.length - 1]).toBeGreaterThan(result[0] * 1.5);
});

test('loss / high RTT / jitter backs the bitrate off', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const core = await import('./core.bundle.js');
    const ctrl = new core.AdaptiveController({ minKbps: 300, maxKbps: 40000, targetRttMs: 120 });
    const base = {
      fps: 60,
      width: 1920,
      height: 1080,
      availableKbps: 50000,
      ts: Date.now(),
    };
    // Ramp up on a clean link first.
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = ctrl.update({ rttMs: 20, lossPct: 0, jitterMs: 2, ...base }).targetKbps;
    }
    const peak = last;
    // Now inject congestion: heavy loss + high RTT + jitter.
    const afterLoss: number[] = [];
    for (let i = 0; i < 5; i++) {
      afterLoss.push(
        ctrl.update({ rttMs: 400, lossPct: 12, jitterMs: 80, availableKbps: 0, ...{ fps: 30, width: 1920, height: 1080, ts: Date.now() } }).targetKbps,
      );
    }
    return { peak, afterLoss };
  });

  // First congested decision is already below the peak (fast back-off).
  expect(result.afterLoss[0]).toBeLessThan(result.peak);
  // Sustained congestion keeps decreasing (multiplicative decrease).
  for (let i = 1; i < result.afterLoss.length; i++) {
    expect(result.afterLoss[i]).toBeLessThanOrEqual(result.afterLoss[i - 1]);
  }
  expect(result.afterLoss[result.afterLoss.length - 1]).toBeLessThan(result.peak);
});

test('decisions clamp to bounds and derive sane framerate/scale', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const core = await import('./core.bundle.js');
    const ctrl = new core.AdaptiveController({ minKbps: 500, maxKbps: 5000, targetRttMs: 120 });

    // Drive hard up against the ceiling on a pristine link.
    let high: import('@stream-screen/core').AdaptiveDecision | undefined;
    for (let i = 0; i < 30; i++) {
      high = ctrl.update({ rttMs: 5, lossPct: 0, jitterMs: 0, availableKbps: 1e9, fps: 60, width: 1920, height: 1080, ts: Date.now() });
    }

    // Drive hard down against the floor with severe congestion.
    let low: import('@stream-screen/core').AdaptiveDecision | undefined;
    for (let i = 0; i < 30; i++) {
      low = ctrl.update({ rttMs: 2000, lossPct: 50, jitterMs: 500, availableKbps: 1, fps: 5, width: 640, height: 480, ts: Date.now() });
    }
    return { high: high!, low: low! };
  });

  // Clamped to [minKbps, maxKbps].
  expect(result.high.targetKbps).toBeLessThanOrEqual(5000);
  expect(result.high.targetKbps).toBeGreaterThan(4000); // got near the ceiling
  expect(result.low.targetKbps).toBeGreaterThanOrEqual(500);
  expect(result.low.targetKbps).toBeLessThan(1000); // pinned near the floor

  // Headroom-rich decision picks higher framerate and no/low downscale.
  expect(result.high.maxFramerate).toBeGreaterThanOrEqual(result.low.maxFramerate);
  expect(result.high.scaleResolutionDownBy).toBeLessThanOrEqual(result.low.scaleResolutionDownBy);
  expect(result.low.scaleResolutionDownBy).toBeGreaterThanOrEqual(1);
});
