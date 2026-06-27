/**
 * auth-verifier — verify a viewer's PIN proof against the host's stored
 * verifier, gated by the {@link LockoutTracker}.
 *
 * This is the host-side counterpart to the viewer's proof computation. It is a
 * thin, pure orchestration layer over the @stream-screen/core primitive
 * {@link verifyProofAgainst}: it ONLY adds the online-brute-force defense
 * (lockout) around the (expensive) KDF/HMAC verification.
 *
 * ORDER MATTERS for security:
 *   1. Check the lockout FIRST. A locked key is rejected WITHOUT running any
 *      KDF/HMAC — never burn PBKDF2 CPU for a rate-limited attacker.
 *   2. Otherwise verify the proof (constant-time inside core).
 *   3. On success → reset the lockout for that key. On failure → bump it.
 *
 * FAIL-CLOSED: any decode/compute error inside core yields a non-match (and is
 * therefore counted as a failure), never an accidental accept.
 */

import { fromBase64, verifyProofAgainst, type VerifierRecord } from '@stream-screen/core';
import { LockoutTracker, type LockoutKeyParts } from './lockout-tracker.js';

/** The inputs needed to verify one viewer auth-response. */
export interface AuthAttempt {
  /** The host's stored verifier (salt + derived key + iterations). */
  record: VerifierRecord;
  /** base64 viewer-supplied proof (from the auth-response). */
  proof: string;
  /** The host nonce that was issued in the auth-challenge. */
  nonceH: Uint8Array;
  /** base64 viewer nonce (from the auth-response). */
  nonceV: string;
  /** The canonical DTLS channel binding both peers derived. */
  channelBinding: string;
  /** The domain-separation tag (core AUTH_DOMAIN). */
  domain: string;
  /** Lockout key parts (source ip + peer id). */
  key: LockoutKeyParts;
}

/** Why an attempt was rejected (for host-side logging only; never sent on wire). */
export type AuthFailReason = 'locked' | 'bad-proof' | 'malformed';

/** The verdict of one verification attempt. */
export interface AuthOutcome {
  ok: boolean;
  reason?: AuthFailReason;
  /** Ms the caller should wait before this key may try again (lockout). */
  retryAfterMs: number;
}

export class AuthVerifier {
  constructor(private readonly lockout: LockoutTracker) {}

  /**
   * Verify one auth attempt.
   *
   * - If the key is LOCKED → reject immediately as 'locked', running NO KDF.
   * - Else verify the proof. A valid proof resets the lockout and returns ok.
   * - An invalid proof (or a malformed nonce/proof) bumps the lockout and
   *   returns the resulting retry delay.
   */
  async verify(attempt: AuthAttempt): Promise<AuthOutcome> {
    const gate = this.lockout.check(attempt.key);
    if (gate.locked) {
      // CRITICAL: do not run the KDF/HMAC for a locked key.
      return { ok: false, reason: 'locked', retryAfterMs: gate.retryAfterMs };
    }

    // Decode the wire-supplied fields. Malformed base64 is a failed attempt
    // (fail-closed) and still counts toward lockout so an attacker cannot dodge
    // rate-limiting by sending garbage.
    let nonceV: Uint8Array;
    let proof: Uint8Array;
    try {
      nonceV = fromBase64(attempt.nonceV);
      proof = fromBase64(attempt.proof);
    } catch {
      const after = this.lockout.recordFailure(attempt.key);
      return { ok: false, reason: 'malformed', retryAfterMs: after.retryAfterMs };
    }

    const ok = await verifyProofAgainst(attempt.record, proof, {
      domain: attempt.domain,
      nonceH: attempt.nonceH,
      nonceV,
      channelBinding: attempt.channelBinding,
    });

    if (ok) {
      this.lockout.recordSuccess(attempt.key);
      return { ok: true, retryAfterMs: 0 };
    }
    const after = this.lockout.recordFailure(attempt.key);
    return { ok: false, reason: 'bad-proof', retryAfterMs: after.retryAfterMs };
  }
}
