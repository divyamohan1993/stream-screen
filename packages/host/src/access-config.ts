/**
 * access-config — parse the host's access-control configuration from the
 * environment and build the (non-reversible) PIN verifier.
 *
 * The host operator picks an ACCESS MODE via `STREAMSCREEN_ACCESS_MODE`:
 *
 *   - 'open'            DEFAULT. Preserves the historical behavior exactly:
 *                       sessions are gated only by the numeric session code,
 *                       with NO consent prompt and NO PIN. All existing e2e
 *                       specs must keep passing unchanged in this mode.
 *   - 'prompt'          A human at the host must Accept each inbound viewer.
 *                       No PIN.
 *   - 'pin'             Unattended: the viewer must present a valid PIN proof
 *                       over the encrypted data channel. No human prompt.
 *   - 'pin-and-prompt'  Both a valid PIN proof AND a human Accept.
 *
 * FAIL-CLOSED: if a PIN mode ('pin'/'pin-and-prompt') is requested but no valid
 * PIN is supplied (`STREAMSCREEN_PIN` missing or failing {@link validatePin}),
 * we DO NOT silently downgrade to 'open'. Instead the resolved config reports a
 * fatal error and an effective mode of 'refuse' — the host must refuse ALL
 * inbound connections. This is the secure default: a misconfigured PIN must
 * never collapse into unauthenticated access.
 *
 * ZERO-TRUST: the verifier is built here (host-side) and never leaves the host;
 * only the salt/iterations (public KDF parameters) ever go on the wire, in the
 * auth-challenge. The plaintext PIN is never stored or transmitted.
 */

import {
  makeVerifier,
  validatePin,
  type VerifierRecord,
} from '@stream-screen/core';

/**
 * The access modes a host can be configured into.
 *
 * 'refuse' is NOT a user-selectable mode — it is the fail-closed EFFECTIVE mode
 * the resolver falls into when a PIN mode was requested without a usable PIN.
 */
export type AccessMode = 'open' | 'prompt' | 'pin' | 'pin-and-prompt' | 'refuse';

/** The set of modes a user may explicitly request via the environment. */
export const REQUESTABLE_MODES: ReadonlySet<string> = new Set([
  'open',
  'prompt',
  'pin',
  'pin-and-prompt',
]);

/** True if the (effective) mode requires a PIN proof from the viewer. */
export function modeRequiresPin(mode: AccessMode): boolean {
  return mode === 'pin' || mode === 'pin-and-prompt';
}

/** True if the (effective) mode requires a human Accept at the host. */
export function modeRequiresPrompt(mode: AccessMode): boolean {
  return mode === 'prompt' || mode === 'pin-and-prompt';
}

/**
 * The challenge `mode` value sent to the viewer for a PIN-bearing handshake.
 * Only 'pin' / 'pin-and-prompt' / 'prompt' are valid on the wire — 'open' never
 * issues a challenge and 'refuse' never accepts. Narrowing helper for typing the
 * auth-challenge ControlMessage.
 */
export type ChallengeMode = 'pin' | 'pin-and-prompt' | 'prompt';

/** Coerce an effective access mode to its wire challenge mode, if any. */
export function challengeModeOf(mode: AccessMode): ChallengeMode | null {
  if (mode === 'pin' || mode === 'pin-and-prompt' || mode === 'prompt') return mode;
  return null;
}

/** The raw inputs the resolver reads (so it is pure and unit-testable). */
export interface AccessEnv {
  /** `STREAMSCREEN_ACCESS_MODE` (case-insensitive; unset/blank ⇒ 'open'). */
  mode?: string;
  /** `STREAMSCREEN_PIN` (the plaintext PIN; never persisted). */
  pin?: string;
}

/** The fully-resolved access configuration the host session runs against. */
export interface AccessConfig {
  /** The mode that was REQUESTED (after normalization), for logging/UI. */
  requestedMode: AccessMode;
  /**
   * The EFFECTIVE mode the host actually enforces. Equals `requestedMode` on
   * success; becomes 'refuse' when a PIN mode was requested without a valid PIN
   * (fail-closed). 'open' when nothing was requested.
   */
  mode: AccessMode;
  /**
   * The PIN verifier (salt + PBKDF2-derived key), present only for a successful
   * PIN mode. Null otherwise. NEVER contains the plaintext PIN.
   */
  verifier: VerifierRecord | null;
  /**
   * A human-readable fatal error explaining a fail-closed 'refuse', or null when
   * the configuration is valid. The host should LOG this clearly at startup.
   */
  error: string | null;
}

/**
 * Normalize the requested mode string. Unknown / blank values fall back to
 * 'open' (the default) — an UNKNOWN mode is treated as the safe default rather
 * than an error, because a typo in a non-PIN setting should not lock the host
 * out; only PIN modes are security-critical and those are validated below.
 */
function normalizeMode(raw: string | undefined): {
  mode: 'open' | 'prompt' | 'pin' | 'pin-and-prompt';
  unknown: boolean;
} {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' ) return { mode: 'open', unknown: false };
  if (REQUESTABLE_MODES.has(v)) {
    return { mode: v as 'open' | 'prompt' | 'pin' | 'pin-and-prompt', unknown: false };
  }
  return { mode: 'open', unknown: true };
}

/**
 * Resolve the access configuration from environment-shaped inputs.
 *
 * Pure and async (the verifier KDF is async). Build the verifier ONLY for a
 * valid PIN mode; for an invalid PIN in a PIN mode, fail closed to 'refuse'
 * with a descriptive error and NO verifier.
 *
 * @param env  the environment inputs (mode + pin).
 * @param iterations  optional KDF iteration override (tests use a tiny value so
 *   they run fast; production uses the core default of 600k).
 */
export async function resolveAccessConfig(
  env: AccessEnv,
  iterations?: number,
): Promise<AccessConfig> {
  const { mode: requested, unknown } = normalizeMode(env.mode);

  // Non-PIN modes never need a verifier.
  if (requested === 'open' || requested === 'prompt') {
    return {
      requestedMode: requested,
      mode: requested,
      verifier: null,
      error: unknown
        ? `Unknown STREAMSCREEN_ACCESS_MODE "${env.mode}"; defaulting to "open".`
        : null,
    };
  }

  // PIN modes ('pin' / 'pin-and-prompt'): a valid PIN is MANDATORY. Fail closed.
  const pin = env.pin ?? '';
  if (pin.length === 0) {
    return {
      requestedMode: requested,
      mode: 'refuse',
      verifier: null,
      error:
        `STREAMSCREEN_ACCESS_MODE="${requested}" requires STREAMSCREEN_PIN, but none ` +
        `was provided. Refusing all connections (fail-closed). Set a valid PIN or ` +
        `use STREAMSCREEN_ACCESS_MODE=open.`,
    };
  }
  const policy = validatePin(pin);
  if (!policy.ok) {
    return {
      requestedMode: requested,
      mode: 'refuse',
      verifier: null,
      error:
        `STREAMSCREEN_PIN rejected by policy (${policy.reason}). Refusing all ` +
        `connections (fail-closed). Choose a PIN of at least 6 characters that is ` +
        `not all-identical and not a simple sequence.`,
    };
  }

  const verifier = await makeVerifier(pin, iterations);
  return {
    requestedMode: requested,
    mode: requested,
    verifier,
    error: null,
  };
}
