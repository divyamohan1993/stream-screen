/**
 * Unit tests for the pure helpers in host-session that run without Electron or
 * a live WebRTC stack.
 */

import { describe, expect, it } from 'vitest';
import { generateSessionCode } from '../src/host-session.js';

describe('generateSessionCode', () => {
  it('produces a 6-digit numeric code by default', () => {
    const code = generateSessionCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('honors a requested length within 6..9', () => {
    expect(generateSessionCode(9)).toMatch(/^\d{9}$/);
    expect(generateSessionCode(8)).toMatch(/^\d{8}$/);
  });

  it('clamps lengths below 6 and above 9', () => {
    expect(generateSessionCode(3)).toHaveLength(6);
    expect(generateSessionCode(20)).toHaveLength(9);
  });

  it('is deterministic given an injected RNG', () => {
    const code = generateSessionCode(6, () => 0.5);
    expect(code).toBe('555555');
  });
});
