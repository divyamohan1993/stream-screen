import React, { useEffect, useRef, useState } from 'react';
import type { AuthChallenge } from '../viewer-session.js';

/** Props for {@link AuthPrompt}. */
export interface AuthPromptProps {
  /** The pending auth challenge (mode + whether a PIN is required). */
  challenge: AuthChallenge;
  /** True once the host returned a denial; surfaces the error + retry. */
  denied: boolean;
  /**
   * True when the session holds a FRESH (unconsumed) challenge that a PIN can be
   * submitted against. The session drops the challenge on a denial and only
   * re-arms when the host sends a new `auth-challenge` (new nonce), so Retry is
   * gated on this: after a wrong PIN the button stays disabled until a fresh
   * challenge arrives. If the host locks the viewer out (no fresh challenge ever
   * follows) this stays false and the denial reads as locked-out. Defaults to
   * `true` for the first, never-yet-denied attempt.
   */
  armed: boolean;
  /** True while a submitted PIN is being derived/verified (proof in flight). */
  submitting: boolean;
  /**
   * Submit a PIN to the host (for `'pin'` / `'pin-and-prompt'` modes). The PIN is
   * handed off and never retained by this component beyond the submit.
   */
  onSubmitPin: (pin: string) => void;
  /** Abandon the connection attempt. */
  onCancel: () => void;
}

/**
 * Consent / access-PIN gate shown while the host's auth handshake is pending.
 *
 * Three shapes, driven by the challenge `mode`:
 *  - `'prompt'`: a non-interactive "waiting for host approval" notice — the host
 *    operator must Accept. No PIN field, no proof.
 *  - `'pin'` / `'pin-and-prompt'`: a PIN entry field. On submit the parent
 *    derives the proof (via the session) and sends the response. The local PIN
 *    string is cleared from component state immediately after submit so it is
 *    never retained.
 *
 * A denial (`auth-result{ok:false}`) surfaces a reason-free "Access denied"
 * message with a retry affordance (re-enter the PIN), per protocol design.
 */
export function AuthPrompt({
  challenge,
  denied,
  armed,
  submitting,
  onSubmitPin,
  onCancel,
}: AuthPromptProps): React.JSX.Element {
  const [pin, setPin] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the PIN field when it appears, and re-focus when a fresh challenge
  // re-arms it for retry (the field is disabled while disarmed, so only focus
  // once it can actually accept input).
  useEffect(() => {
    if (challenge.needsPin && armed) inputRef.current?.focus();
  }, [challenge.needsPin, armed, denied]);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const value = pin;
    if (!value) return;
    // Clear the local copy immediately; the session derives the proof and never
    // stores the PIN.
    setPin('');
    onSubmitPin(value);
  };

  if (!challenge.needsPin) {
    // Prompt-only: nothing for the viewer to enter. Either we are waiting for the
    // host operator to Accept, or they have declined (denial) — in prompt mode a
    // denial is terminal (no PIN to retry), so we surface it and offer only a way
    // out.
    return (
      <div
        className="auth-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={denied ? 'Connection declined' : 'Awaiting host approval'}
      >
        <div className="auth-card">
          {denied ? (
            <>
              <h2 className="auth-title">Connection declined</h2>
              <p className="auth-error" role="alert">
                The host declined your connection.
              </p>
            </>
          ) : (
            <>
              <h2 className="auth-title">Waiting for host approval…</h2>
              <p className="auth-desc" role="status" aria-live="polite">
                The host must accept your connection on their computer.
              </p>
            </>
          )}
          <div className="auth-actions">
            <button type="button" className="auth-cancel" onClick={onCancel}>
              {denied ? 'Close' : 'Cancel'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-prompt" role="dialog" aria-modal="true" aria-label="Enter access PIN">
      <form className="auth-card" onSubmit={submit}>
        <h2 className="auth-title">Enter access PIN</h2>
        <p className="auth-desc">This host is protected by a PIN. Ask the host operator for it.</p>
        {denied &&
          (armed ? (
            <p className="auth-error" role="alert">
              Incorrect PIN. Try again.
            </p>
          ) : (
            <p className="auth-error" role="alert">
              Access denied. The host has not re-issued a challenge.
            </p>
          ))}
        <label className="auth-field">
          <span className="sr-only">Access PIN</span>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            aria-label="Access PIN"
            disabled={submitting || !armed}
          />
        </label>
        <div className="auth-actions">
          <button type="button" className="auth-cancel" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            className="auth-submit"
            // Retry is inert until a FRESH challenge re-arms the session, so a
            // proof is never computed against a consumed nonce.
            disabled={submitting || !armed || pin.length === 0}
          >
            {submitting ? 'Verifying…' : denied ? 'Retry' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}
