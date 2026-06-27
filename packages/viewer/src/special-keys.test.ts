import { describe, it, expect } from 'vitest';
import { buildKeyCombo, CTRL_ALT_DEL, SPECIAL_KEYS, KEY_MODS } from '@stream-screen/core';

/**
 * Feature F: the viewer relies on core's combo builder to emit special-key
 * chords. These tests pin the contract the viewer's toolbar actions depend on.
 */
describe('buildKeyCombo', () => {
  it('presses in order with cumulative mods, then releases in reverse', () => {
    const events = buildKeyCombo(['ctrl', 'alt', 'delete']);
    // 3 presses + 3 releases.
    expect(events.length).toBe(6);
    const downs = events.filter((e) => e.t === 'k-down');
    const ups = events.filter((e) => e.t === 'k-up');
    expect(downs.length).toBe(3);
    expect(ups.length).toBe(3);
    // Releases happen in reverse order of presses.
    const downCodes = downs.map((e) => (e.t === 'k-down' ? e.code : ''));
    const upCodes = ups.map((e) => (e.t === 'k-up' ? e.code : ''));
    expect(upCodes).toEqual([...downCodes].reverse());
  });

  it('accumulates the modifier bitmask across the chord', () => {
    const events = buildKeyCombo(['ctrl', 'alt', 'delete']);
    // The final press (delete) should carry ctrl|alt in its mods.
    const lastDown = [...events].reverse().find((e) => e.t === 'k-down');
    expect(lastDown && lastDown.t === 'k-down' ? lastDown.mods & KEY_MODS.ctrl : 0).toBe(
      KEY_MODS.ctrl,
    );
    expect(lastDown && lastDown.t === 'k-down' ? lastDown.mods & KEY_MODS.alt : 0).toBe(
      KEY_MODS.alt,
    );
  });
});

describe('SPECIAL_KEYS / CTRL_ALT_DEL', () => {
  it('CTRL_ALT_DEL is a non-empty ordered event list', () => {
    expect(Array.isArray(CTRL_ALT_DEL)).toBe(true);
    expect(CTRL_ALT_DEL.length).toBeGreaterThan(0);
    expect(CTRL_ALT_DEL.every((e) => e.t === 'k-down' || e.t === 'k-up')).toBe(true);
  });

  it('exposes the WIN chord the toolbar sends', () => {
    expect(Array.isArray(SPECIAL_KEYS.WIN)).toBe(true);
    expect(SPECIAL_KEYS.WIN.length).toBeGreaterThan(0);
  });
});
