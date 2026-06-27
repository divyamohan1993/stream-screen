/**
 * Unit tests for {@link resolveAccessConfig} — environment parsing + fail-closed
 * behavior for misconfigured PIN modes. Uses a tiny KDF iteration count so the
 * verifier builds fast.
 */

import { describe, expect, it } from 'vitest';
import { deriveKey, fromBase64, toBase64 } from '@stream-screen/core';
import {
  challengeModeOf,
  modeRequiresPin,
  modeRequiresPrompt,
  resolveAccessConfig,
} from '../src/access-config.js';

const ITERS = 100;

describe('resolveAccessConfig', () => {
  it('defaults to "open" when no mode is set', async () => {
    const c = await resolveAccessConfig({}, ITERS);
    expect(c.mode).toBe('open');
    expect(c.verifier).toBeNull();
    expect(c.error).toBeNull();
  });

  it('treats blank/whitespace mode as "open"', async () => {
    const c = await resolveAccessConfig({ mode: '   ' }, ITERS);
    expect(c.mode).toBe('open');
  });

  it('parses "prompt" with no PIN required', async () => {
    const c = await resolveAccessConfig({ mode: 'prompt' }, ITERS);
    expect(c.mode).toBe('prompt');
    expect(c.verifier).toBeNull();
    expect(c.error).toBeNull();
  });

  it('is case-insensitive', async () => {
    const c = await resolveAccessConfig({ mode: 'PROMPT' }, ITERS);
    expect(c.mode).toBe('prompt');
  });

  it('builds a verifier for "pin" with a valid PIN', async () => {
    const c = await resolveAccessConfig({ mode: 'pin', pin: 'goodpin99' }, ITERS);
    expect(c.mode).toBe('pin');
    expect(c.error).toBeNull();
    expect(c.verifier).not.toBeNull();
    expect(c.verifier!.alg).toBe('pbkdf2-sha256');
    expect(c.verifier!.iterations).toBe(ITERS);
    // The verifier must NOT contain the plaintext PIN, and the stored key must
    // equal a fresh derivation from the same salt/iters (it is the PBKDF2 key).
    const serialized = JSON.stringify(c.verifier);
    expect(serialized).not.toContain('goodpin99');
    const rederived = await deriveKey('goodpin99', fromBase64(c.verifier!.salt), ITERS);
    expect(toBase64(rederived)).toBe(c.verifier!.key);
  });

  it('builds a verifier for "pin-and-prompt"', async () => {
    const c = await resolveAccessConfig({ mode: 'pin-and-prompt', pin: 'goodpin99' }, ITERS);
    expect(c.mode).toBe('pin-and-prompt');
    expect(c.verifier).not.toBeNull();
  });

  it('FAILS CLOSED to "refuse" when a PIN mode has no PIN (no downgrade to open)', async () => {
    const c = await resolveAccessConfig({ mode: 'pin' }, ITERS);
    expect(c.requestedMode).toBe('pin');
    expect(c.mode).toBe('refuse');
    expect(c.verifier).toBeNull();
    expect(c.error).toBeTruthy();
    // Must NOT silently become 'open'.
    expect(c.mode).not.toBe('open');
  });

  it('FAILS CLOSED to "refuse" when the PIN violates policy (too short)', async () => {
    const c = await resolveAccessConfig({ mode: 'pin', pin: '123' }, ITERS);
    expect(c.mode).toBe('refuse');
    expect(c.verifier).toBeNull();
    expect(c.error).toContain('too-short');
  });

  it('FAILS CLOSED to "refuse" for a sequential PIN', async () => {
    const c = await resolveAccessConfig({ mode: 'pin', pin: '123456' }, ITERS);
    expect(c.mode).toBe('refuse');
    expect(c.error).toContain('sequential');
  });

  it('FAILS CLOSED to "refuse" for an all-same PIN', async () => {
    const c = await resolveAccessConfig({ mode: 'pin-and-prompt', pin: '000000' }, ITERS);
    expect(c.mode).toBe('refuse');
    expect(c.error).toContain('all-same');
  });

  it('treats an unknown mode as "open" with a note (does not lock out)', async () => {
    const c = await resolveAccessConfig({ mode: 'bogus' }, ITERS);
    expect(c.mode).toBe('open');
    expect(c.error).toBeTruthy();
  });

  it('mode predicate helpers are correct', () => {
    expect(modeRequiresPin('pin')).toBe(true);
    expect(modeRequiresPin('pin-and-prompt')).toBe(true);
    expect(modeRequiresPin('prompt')).toBe(false);
    expect(modeRequiresPin('open')).toBe(false);
    expect(modeRequiresPrompt('prompt')).toBe(true);
    expect(modeRequiresPrompt('pin-and-prompt')).toBe(true);
    expect(modeRequiresPrompt('pin')).toBe(false);
    expect(challengeModeOf('pin')).toBe('pin');
    expect(challengeModeOf('open')).toBeNull();
    expect(challengeModeOf('refuse')).toBeNull();
  });
});
