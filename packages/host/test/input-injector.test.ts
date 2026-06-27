/**
 * Unit tests for the PURE mapping helpers in input-injector.
 *
 * These run on any platform (including Linux/CI) WITHOUT the native
 * `@nut-tree-fork/nut-js` library installed, because the helpers under test are
 * deliberately free of any nut.js calls.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeModifiers,
  mapButton,
  mapKeyCode,
  modifierKeyNames,
  normalizedToPixels,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
} from '../src/input-injector.js';

describe('normalizedToPixels', () => {
  const screen = { width: 1920, height: 1080 };

  it('maps 0,0 to the top-left pixel', () => {
    expect(normalizedToPixels(0, 0, screen)).toEqual({ x: 0, y: 0 });
  });

  it('maps 1,1 to the bottom-right pixel', () => {
    expect(normalizedToPixels(1, 1, screen)).toEqual({ x: 1919, y: 1079 });
  });

  it('maps the center', () => {
    expect(normalizedToPixels(0.5, 0.5, screen)).toEqual({ x: 960, y: 540 });
  });

  it('clamps out-of-range values into the screen', () => {
    expect(normalizedToPixels(-0.5, 2, screen)).toEqual({ x: 0, y: 1079 });
  });

  it('handles non-finite input as 0', () => {
    expect(normalizedToPixels(Number.NaN, Number.POSITIVE_INFINITY, screen)).toEqual({
      x: 0,
      y: 1079,
    });
  });

  it('works on an arbitrary resolution', () => {
    expect(normalizedToPixels(0.5, 0.5, { width: 1280, height: 720 })).toEqual({
      x: 640,
      y: 360,
    });
  });
});

describe('mapButton', () => {
  it('maps left/middle/right to nut.js LEFT/MIDDLE/RIGHT', () => {
    expect(mapButton(0)).toBe(0); // LEFT
    expect(mapButton(1)).toBe(1); // MIDDLE
    expect(mapButton(2)).toBe(2); // RIGHT
  });
});

describe('decodeModifiers', () => {
  it('decodes individual flags', () => {
    expect(decodeModifiers(MOD_SHIFT)).toEqual({
      shift: true,
      ctrl: false,
      alt: false,
      meta: false,
    });
    expect(decodeModifiers(MOD_CTRL)).toMatchObject({ ctrl: true });
    expect(decodeModifiers(MOD_ALT)).toMatchObject({ alt: true });
    expect(decodeModifiers(MOD_META)).toMatchObject({ meta: true });
  });

  it('decodes combined flags (ctrl+shift)', () => {
    expect(decodeModifiers(MOD_CTRL | MOD_SHIFT)).toEqual({
      shift: true,
      ctrl: true,
      alt: false,
      meta: false,
    });
  });

  it('decodes all flags set', () => {
    expect(decodeModifiers(MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_META)).toEqual({
      shift: true,
      ctrl: true,
      alt: true,
      meta: true,
    });
  });

  it('treats 0 as no modifiers', () => {
    expect(decodeModifiers(0)).toEqual({
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    });
  });
});

describe('modifierKeyNames', () => {
  it('returns the nut.js key names in stable order', () => {
    expect(modifierKeyNames(MOD_CTRL | MOD_ALT | MOD_SHIFT | MOD_META)).toEqual([
      'LeftControl',
      'LeftAlt',
      'LeftShift',
      'LeftSuper',
    ]);
  });

  it('returns an empty array for no modifiers', () => {
    expect(modifierKeyNames(0)).toEqual([]);
  });
});

describe('mapKeyCode', () => {
  it('maps letter codes', () => {
    expect(mapKeyCode('KeyA')).toBe('A');
    expect(mapKeyCode('KeyZ')).toBe('Z');
  });

  it('maps top-row digits to Num0..Num9', () => {
    expect(mapKeyCode('Digit0')).toBe('Num0');
    expect(mapKeyCode('Digit9')).toBe('Num9');
  });

  it('maps numpad digits to NumPad0..NumPad9', () => {
    expect(mapKeyCode('Numpad5')).toBe('NumPad5');
  });

  it('maps function keys through unchanged', () => {
    expect(mapKeyCode('F1')).toBe('F1');
    expect(mapKeyCode('F12')).toBe('F12');
    expect(mapKeyCode('F24')).toBe('F24');
  });

  it('maps named keys via the static table', () => {
    expect(mapKeyCode('Enter')).toBe('Enter');
    expect(mapKeyCode('ArrowLeft')).toBe('Left');
    expect(mapKeyCode('Escape')).toBe('Escape');
    expect(mapKeyCode('Space')).toBe('Space');
    expect(mapKeyCode('ControlLeft')).toBe('LeftControl');
  });

  it('returns null for unmappable codes', () => {
    expect(mapKeyCode('Unidentified')).toBeNull();
    expect(mapKeyCode('F25')).toBeNull();
  });
});
