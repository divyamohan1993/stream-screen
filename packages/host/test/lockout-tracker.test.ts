/**
 * Unit tests for {@link LockoutTracker} — the online brute-force defense.
 *
 * Covers: threshold trigger, exponential backoff growth + cap, reset on success,
 * per-key isolation, and the critical "a locked key is rejected without running
 * the KDF" property (asserted via the AuthVerifier integration test, but the
 * pure `check()` contract is verified here).
 */

import { describe, expect, it } from 'vitest';
import { LockoutTracker } from '../src/lockout-tracker.js';

const KEY = { ip: '10.0.0.5', peerId: 'viewer-1' };

function trackerAt(start = 0): { tr: LockoutTracker; advance: (ms: number) => void } {
  let t = start;
  const tr = new LockoutTracker({ threshold: 5, baseMs: 1000, capMs: 30 * 60_000, now: () => t });
  return { tr, advance: (ms) => (t += ms) };
}

describe('LockoutTracker', () => {
  it('does not lock before the threshold is reached', () => {
    const { tr } = trackerAt();
    for (let i = 0; i < 4; i++) {
      const d = tr.recordFailure(KEY);
      expect(d.locked).toBe(false);
    }
    expect(tr.check(KEY).locked).toBe(false);
    expect(tr.failCount(KEY)).toBe(4);
  });

  it('locks once the threshold (5) is hit, for the base backoff', () => {
    const { tr } = trackerAt();
    let d = { locked: false, retryAfterMs: 0, attemptDelayMs: 0 };
    for (let i = 0; i < 5; i++) d = tr.recordFailure(KEY);
    expect(d.locked).toBe(true);
    expect(d.retryAfterMs).toBe(1000); // base
    expect(tr.check(KEY).locked).toBe(true);
  });

  it('grows the backoff exponentially with each further failure', () => {
    const { tr, advance } = trackerAt();
    for (let i = 0; i < 5; i++) tr.recordFailure(KEY); // locked 1000ms
    advance(1000); // lockout expires
    expect(tr.check(KEY).locked).toBe(false);
    const d6 = tr.recordFailure(KEY); // 6th fail → 2000ms
    expect(d6.retryAfterMs).toBe(2000);
    advance(2000);
    const d7 = tr.recordFailure(KEY); // 7th fail → 4000ms
    expect(d7.retryAfterMs).toBe(4000);
  });

  it('caps the backoff at the configured maximum (~30 min)', () => {
    const { tr, advance } = trackerAt();
    // Drive many failures; the backoff must never exceed the cap.
    for (let i = 0; i < 5; i++) tr.recordFailure(KEY);
    let last = 1000;
    for (let i = 0; i < 40; i++) {
      advance(last);
      const d = tr.recordFailure(KEY);
      expect(d.retryAfterMs).toBeLessThanOrEqual(30 * 60_000);
      last = d.retryAfterMs;
    }
    expect(last).toBe(30 * 60_000); // saturated at the cap
  });

  it('resets fully on success', () => {
    const { tr } = trackerAt();
    for (let i = 0; i < 5; i++) tr.recordFailure(KEY);
    expect(tr.check(KEY).locked).toBe(true);
    tr.recordSuccess(KEY);
    expect(tr.check(KEY).locked).toBe(false);
    expect(tr.failCount(KEY)).toBe(0);
  });

  it('isolates lockouts per key (one client cannot lock out another)', () => {
    const { tr } = trackerAt();
    const other = { ip: '10.0.0.9', peerId: 'viewer-2' };
    for (let i = 0; i < 5; i++) tr.recordFailure(KEY);
    expect(tr.check(KEY).locked).toBe(true);
    // A different (ip, peerId) is unaffected.
    expect(tr.check(other).locked).toBe(false);
    expect(tr.failCount(other)).toBe(0);
  });

  it('treats different ip OR different peerId as distinct keys', () => {
    const { tr } = trackerAt();
    for (let i = 0; i < 5; i++) tr.recordFailure({ ip: 'a', peerId: 'p' });
    expect(tr.check({ ip: 'a', peerId: 'p' }).locked).toBe(true);
    expect(tr.check({ ip: 'b', peerId: 'p' }).locked).toBe(false);
    expect(tr.check({ ip: 'a', peerId: 'q' }).locked).toBe(false);
  });

  it('check() does not mutate state (safe to call speculatively)', () => {
    const { tr } = trackerAt();
    tr.check(KEY);
    tr.check(KEY);
    expect(tr.failCount(KEY)).toBe(0);
  });
});
