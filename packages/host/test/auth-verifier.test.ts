/**
 * Unit tests for {@link AuthVerifier} — host-side PIN proof verification gated by
 * the lockout. Uses the REAL @stream-screen/core crypto with a tiny iteration
 * count so the KDF runs fast.
 *
 * Covers: a valid proof verifies and resets the lockout; a wrong proof fails and
 * bumps the lockout; a locked key is rejected WITHOUT running the KDF (asserted
 * via a counting spy on the iterations actually consumed); replay against a fresh
 * nonce fails; malformed input fails closed and still counts toward lockout.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_DOMAIN,
  computeProof,
  deriveKey,
  fromBase64,
  makeVerifier,
  NONCE_BYTES,
  randomBytes,
  toBase64,
  type VerifierRecord,
} from '@stream-screen/core';
import { AuthVerifier } from '../src/auth-verifier.js';
import { LockoutTracker } from '../src/lockout-tracker.js';

const PIN = 'sw0rdfish';
const ITERS = 100; // fast KDF for tests
const CB = 'fpA|fpB';
const KEY = { ip: '10.0.0.5', peerId: 'viewer-1' };

/** Build a valid viewer proof for the given verifier + nonces + binding. */
async function makeProof(
  record: VerifierRecord,
  nonceH: Uint8Array,
  nonceV: Uint8Array,
  channelBinding: string,
  pin = PIN,
): Promise<string> {
  const key = await deriveKey(pin, fromBase64(record.salt), record.iterations);
  const proof = await computeProof(key, {
    domain: AUTH_DOMAIN,
    nonceH,
    nonceV,
    channelBinding,
  });
  return toBase64(proof);
}

function freshTracker(): LockoutTracker {
  let t = 0;
  return new LockoutTracker({ threshold: 5, baseMs: 1000, capMs: 60_000, now: () => t++ });
}

describe('AuthVerifier', () => {
  it('accepts a valid proof and resets the lockout', async () => {
    const record = await makeVerifier(PIN, ITERS);
    const lockout = freshTracker();
    const av = new AuthVerifier(lockout);
    const nonceH = randomBytes(NONCE_BYTES);
    const nonceV = randomBytes(NONCE_BYTES);
    const proof = await makeProof(record, nonceH, nonceV, CB);

    const out = await av.verify({
      record,
      proof,
      nonceH,
      nonceV: toBase64(nonceV),
      channelBinding: CB,
      domain: AUTH_DOMAIN,
      key: KEY,
    });
    expect(out.ok).toBe(true);
    expect(lockout.failCount(KEY)).toBe(0);
  });

  it('rejects a wrong proof (bad PIN) and bumps the lockout', async () => {
    const record = await makeVerifier(PIN, ITERS);
    const lockout = freshTracker();
    const av = new AuthVerifier(lockout);
    const nonceH = randomBytes(NONCE_BYTES);
    const nonceV = randomBytes(NONCE_BYTES);
    // Proof built with the WRONG pin.
    const proof = await makeProof(record, nonceH, nonceV, CB, 'wrong-pin');

    const out = await av.verify({
      record,
      proof,
      nonceH,
      nonceV: toBase64(nonceV),
      channelBinding: CB,
      domain: AUTH_DOMAIN,
      key: KEY,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('bad-proof');
    expect(lockout.failCount(KEY)).toBe(1);
  });

  it('rejects a proof bound to a DIFFERENT channel binding (MITM defense)', async () => {
    const record = await makeVerifier(PIN, ITERS);
    const av = new AuthVerifier(freshTracker());
    const nonceH = randomBytes(NONCE_BYTES);
    const nonceV = randomBytes(NONCE_BYTES);
    // Viewer computed the proof for binding CB, but host verifies a different one.
    const proof = await makeProof(record, nonceH, nonceV, CB);

    const out = await av.verify({
      record,
      proof,
      nonceH,
      nonceV: toBase64(nonceV),
      channelBinding: 'attacker-cb',
      domain: AUTH_DOMAIN,
      key: KEY,
    });
    expect(out.ok).toBe(false);
  });

  it('rejects a captured proof replayed against a FRESH host nonce', async () => {
    const record = await makeVerifier(PIN, ITERS);
    const av = new AuthVerifier(freshTracker());
    const nonceH1 = randomBytes(NONCE_BYTES);
    const nonceV = randomBytes(NONCE_BYTES);
    const proof = await makeProof(record, nonceH1, nonceV, CB);
    // Host now challenges with a different nonce; the old proof must not verify.
    const nonceH2 = randomBytes(NONCE_BYTES);

    const out = await av.verify({
      record,
      proof,
      nonceH: nonceH2,
      nonceV: toBase64(nonceV),
      channelBinding: CB,
      domain: AUTH_DOMAIN,
      key: KEY,
    });
    expect(out.ok).toBe(false);
  });

  it('a locked key is rejected WITHOUT running the KDF (no verifyProofAgainst work)', async () => {
    const record = await makeVerifier(PIN, ITERS);
    let now = 0;
    const lockout = new LockoutTracker({ threshold: 5, baseMs: 10_000, now: () => now });
    const av = new AuthVerifier(lockout);
    // Force the key into a locked state.
    for (let i = 0; i < 5; i++) lockout.recordFailure(KEY);
    expect(lockout.check(KEY).locked).toBe(true);

    // Spy on the core verifier: it must NOT be called while locked.
    const core = await import('@stream-screen/core');
    const spy = vi.spyOn(core, 'verifyProofAgainst');

    const out = await av.verify({
      record,
      proof: 'AAAA',
      nonceH: randomBytes(NONCE_BYTES),
      nonceV: toBase64(randomBytes(NONCE_BYTES)),
      channelBinding: CB,
      domain: AUTH_DOMAIN,
      key: KEY,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('locked');
    expect(out.retryAfterMs).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fails closed on malformed base64 and still counts toward lockout', async () => {
    const record = await makeVerifier(PIN, ITERS);
    const lockout = freshTracker();
    const av = new AuthVerifier(lockout);
    const out = await av.verify({
      record,
      proof: '!!!not-base64!!!',
      nonceH: randomBytes(NONCE_BYTES),
      nonceV: '###',
      channelBinding: CB,
      domain: AUTH_DOMAIN,
      key: KEY,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('malformed');
    expect(lockout.failCount(KEY)).toBe(1);
  });

  it('eventually locks out after repeated wrong proofs', async () => {
    const record = await makeVerifier(PIN, ITERS);
    let now = 0;
    const lockout = new LockoutTracker({ threshold: 5, baseMs: 10_000, now: () => now });
    const av = new AuthVerifier(lockout);
    const nonceH = randomBytes(NONCE_BYTES);
    const nonceV = randomBytes(NONCE_BYTES);
    const bad = await makeProof(record, nonceH, nonceV, CB, 'wrong-pin');

    let out;
    for (let i = 0; i < 5; i++) {
      out = await av.verify({
        record,
        proof: bad,
        nonceH,
        nonceV: toBase64(nonceV),
        channelBinding: CB,
        domain: AUTH_DOMAIN,
        key: KEY,
      });
    }
    expect(out!.ok).toBe(false);
    // 5th failure crosses the threshold → next check is locked.
    expect(lockout.check(KEY).locked).toBe(true);
  });
});
