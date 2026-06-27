import { describe, it, expect } from 'vitest';
import { encodeInput, decodeInput } from '../src/input-codec.js';
import type { InputEvent } from '../src/protocol.js';

const variants: InputEvent[] = [
  { t: 'm-move', x: 0.1234, y: 0.5678 },
  { t: 'm-down', x: 0, y: 1, button: 0 },
  { t: 'm-down', x: 0.5, y: 0.5, button: 1 },
  { t: 'm-up', x: 0.999, y: 0.001, button: 2 },
  { t: 'm-wheel', x: 0.25, y: 0.75, dx: -3, dy: 12 },
  { t: 'k-down', code: 'KeyA', key: 'a', mods: 0 },
  { t: 'k-down', code: 'Enter', key: 'Enter', mods: 1 | 2 | 4 | 8 },
  { t: 'k-up', code: 'ShiftLeft', key: 'Shift', mods: 1 },
  { t: 'clipboard', text: 'hello\nworld "quoted" 😀' },
];

describe('input-codec', () => {
  it('round-trips every InputEvent variant', () => {
    for (const ev of variants) {
      const wire = encodeInput(ev);
      expect(typeof wire).toBe('string');
      const decoded = decodeInput(wire);
      expect(decoded.t).toBe(ev.t);
    }
  });

  it('preserves discrete fields exactly', () => {
    const ev: InputEvent = { t: 'm-wheel', x: 0.5, y: 0.5, dx: -7, dy: 42 };
    expect(decodeInput(encodeInput(ev))).toEqual(ev);

    const k: InputEvent = { t: 'k-down', code: 'KeyZ', key: 'z', mods: 6 };
    expect(decodeInput(encodeInput(k))).toEqual(k);

    const c: InputEvent = { t: 'clipboard', text: 'paste me' };
    expect(decodeInput(encodeInput(c))).toEqual(c);
  });

  it('rounds coordinates to 4 decimals but keeps precision usable', () => {
    const ev: InputEvent = { t: 'm-move', x: 0.123456789, y: 0.987654321 };
    const decoded = decodeInput(encodeInput(ev)) as Extract<InputEvent, { t: 'm-move' }>;
    expect(decoded.x).toBeCloseTo(0.1235, 4);
    expect(decoded.y).toBeCloseTo(0.9877, 4);
  });

  it('preserves button identity for all buttons', () => {
    for (const b of [0, 1, 2] as const) {
      const ev: InputEvent = { t: 'm-down', x: 0.1, y: 0.2, button: b };
      const decoded = decodeInput(encodeInput(ev)) as Extract<InputEvent, { t: 'm-down' }>;
      expect(decoded.button).toBe(b);
    }
  });

  it('throws on malformed wire payloads', () => {
    expect(() => decodeInput('not json')).toThrow();
    expect(() => decodeInput(JSON.stringify({ t: 'bogus' }))).toThrow();
    expect(() => decodeInput(JSON.stringify({ t: 'm-down', x: 0, y: 0, b: 7 }))).toThrow();
    expect(() => decodeInput(JSON.stringify({ t: 'm-move', x: 'a', y: 0 }))).toThrow();
  });
});
