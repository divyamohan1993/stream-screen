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
  InputInjector,
  isCtrlAltDelCombo,
  mapButton,
  mapKeyCode,
  modifierKeyNames,
  normalizedToPixels,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
} from '../src/input-injector.js';
import { CTRL_ALT_DEL, SPECIAL_KEYS } from '@stream-screen/core';
import type { DisplayGeometry } from '../src/monitor.js';

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

  it('maps bare single letters (the AI press_key vocabulary) to the uppercase Key', () => {
    // The press_key schema documents key='a' as a valid example; it must produce
    // a keystroke rather than silently no-opping.
    expect(mapKeyCode('a')).toBe('A');
    expect(mapKeyCode('A')).toBe('A');
    expect(mapKeyCode('z')).toBe('Z');
    expect(mapKeyCode('Z')).toBe('Z');
  });

  it('maps bare single digits to Num0..Num9', () => {
    expect(mapKeyCode('0')).toBe('Num0');
    expect(mapKeyCode('1')).toBe('Num1');
    expect(mapKeyCode('9')).toBe('Num9');
  });

  it('maps single punctuation chars (shifted and unshifted) to their physical key', () => {
    expect(mapKeyCode('-')).toBe('Minus');
    expect(mapKeyCode('_')).toBe('Minus');
    expect(mapKeyCode('/')).toBe('Slash');
    expect(mapKeyCode('?')).toBe('Slash');
    expect(mapKeyCode(';')).toBe('Semicolon');
    expect(mapKeyCode('!')).toBe('Num1');
    expect(mapKeyCode(')')).toBe('Num0');
    expect(mapKeyCode(' ')).toBe('Space');
  });

  it('still maps DOM code strings alongside the bare names', () => {
    // Named codes take priority over single-char handling.
    expect(mapKeyCode('Enter')).toBe('Enter');
    expect(mapKeyCode('Tab')).toBe('Tab');
  });

  it('returns null for unmappable codes', () => {
    expect(mapKeyCode('Unidentified')).toBeNull();
    expect(mapKeyCode('F25')).toBeNull();
    expect(mapKeyCode('')).toBeNull();
    expect(mapKeyCode('ab')).toBeNull();
  });
});

describe('InputInjector (without native nut.js)', () => {
  const geom: DisplayGeometry = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 1280, height: 720 },
    scaleFactor: 1,
  };

  it('tracks the active display geometry', () => {
    const inj = new InputInjector();
    expect(inj.hasDisplayGeometry).toBe(false);
    inj.setDisplayGeometry(geom);
    expect(inj.hasDisplayGeometry).toBe(true);
    inj.setDisplayGeometry(null);
    expect(inj.hasDisplayGeometry).toBe(false);
  });

  it('inject() is a safe no-op when native lib is unavailable', async () => {
    const inj = new InputInjector();
    // Native lib is absent on Linux/CI; these must resolve without throwing.
    await expect(inj.inject({ t: 'm-move', x: 0.5, y: 0.5 })).resolves.toBeUndefined();
  });

  it('paste() is a safe no-op when native lib is unavailable', async () => {
    const inj = new InputInjector();
    await expect(inj.paste()).resolves.toBeUndefined();
  });

  it('injectCombo replays Ctrl+Alt+Del without throwing', async () => {
    const inj = new InputInjector();
    await expect(inj.injectCombo(CTRL_ALT_DEL)).resolves.toBeUndefined();
    // The core combo is a press-then-release sequence of 6 events.
    expect(CTRL_ALT_DEL).toHaveLength(6);
    expect(CTRL_ALT_DEL[0].t).toBe('k-down');
    expect(CTRL_ALT_DEL[CTRL_ALT_DEL.length - 1].t).toBe('k-up');
  });

  it('sendSAS() returns false on non-Windows without throwing', async () => {
    const inj = new InputInjector();
    // This test suite runs on Linux/CI, where there is no sas.dll / PowerShell
    // SAS path; the call must degrade gracefully to false.
    if (process.platform === 'win32') return; // skip on the real target OS
    await expect(inj.sendSAS()).resolves.toBe(false);
  });

  it('injectCombo(Ctrl+Alt+Del) falls back to synthetic replay when SAS is unavailable', async () => {
    const inj = new InputInjector();
    // SAS unavailable on Linux → injectCombo must not throw and must still
    // attempt the synthetic chord (a no-op without native nut.js here).
    await expect(inj.injectCombo(SPECIAL_KEYS.CTRL_ALT_DEL)).resolves.toBeUndefined();
  });
});

describe('isCtrlAltDelCombo', () => {
  it('detects the canonical Ctrl+Alt+Del combo', () => {
    expect(isCtrlAltDelCombo(CTRL_ALT_DEL)).toBe(true);
    expect(isCtrlAltDelCombo(SPECIAL_KEYS.CTRL_ALT_DEL)).toBe(true);
  });

  it('does not match other special chords', () => {
    expect(isCtrlAltDelCombo(SPECIAL_KEYS.WIN)).toBe(false);
    expect(isCtrlAltDelCombo(SPECIAL_KEYS.ALT_TAB)).toBe(false);
    expect(isCtrlAltDelCombo(SPECIAL_KEYS.WIN_R)).toBe(false);
  });

  it('requires BOTH ctrl and alt to be held with Delete', () => {
    // Ctrl+Delete alone (e.g. an editor shortcut) must NOT trigger the SAS path.
    expect(
      isCtrlAltDelCombo([{ t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_CTRL }]),
    ).toBe(false);
    expect(
      isCtrlAltDelCombo([
        { t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_CTRL | MOD_ALT },
      ]),
    ).toBe(true);
  });

  it('ignores k-up events and an empty sequence', () => {
    expect(isCtrlAltDelCombo([])).toBe(false);
    expect(
      isCtrlAltDelCombo([{ t: 'k-up', code: 'Delete', key: 'Delete', mods: MOD_CTRL | MOD_ALT }]),
    ).toBe(false);
  });
});
