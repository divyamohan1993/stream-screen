/**
 * input-injector — translate {@link InputEvent}s received from the viewer into
 * real OS-level mouse/keyboard actions on the host machine.
 *
 * The native automation library `@nut-tree-fork/nut-js` is an OPTIONAL
 * dependency (it ships platform-specific native bindings that only build on the
 * target Windows machine). It is therefore loaded lazily via dynamic
 * `import()`. If the load fails — e.g. on a dev box where the native lib was
 * never installed — injection degrades gracefully: every call logs a single
 * warning and becomes a no-op instead of crashing the host.
 *
 * The PURE mapping logic (normalized→pixel coordinates, button mapping,
 * modifier-bitflag decoding, key-code translation) is exported separately from
 * the nut.js calls so it can be unit-tested on any platform WITHOUT the native
 * library present. Keep that separation intact.
 */

import type { InputEvent } from '@stream-screen/core';

/* -------------------------------------------------------------------------- */
/*  Pure, side-effect-free mapping helpers (unit-tested on Linux)              */
/* -------------------------------------------------------------------------- */

/** A screen size in physical pixels. */
export interface ScreenSize {
  width: number;
  height: number;
}

/** Modifier bitflags as defined by the shared protocol. */
export const MOD_SHIFT = 1;
export const MOD_CTRL = 2;
export const MOD_ALT = 4;
export const MOD_META = 8;

/** nut.js mouse button enum values (LEFT=0, MIDDLE=1, RIGHT=2). */
export type NutButton = 0 | 1 | 2;

/**
 * Map a normalized coordinate (0..1, viewer-relative) to an integer pixel
 * coordinate on a screen of the given size.
 *
 * Input is clamped to [0,1] so a slightly-out-of-range value (e.g. from a
 * pointer event captured at the very edge) never produces an off-screen
 * coordinate. The result is clamped to [0, size-1] and rounded to the nearest
 * pixel.
 */
export function normalizedToPixels(
  x: number,
  y: number,
  screen: ScreenSize,
): { x: number; y: number } {
  const nx = clamp01(x);
  const ny = clamp01(y);
  const px = Math.min(screen.width - 1, Math.max(0, Math.round(nx * (screen.width - 1))));
  const py = Math.min(screen.height - 1, Math.max(0, Math.round(ny * (screen.height - 1))));
  return { x: px, y: py };
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Map a protocol button (0 left, 1 middle, 2 right) to the nut.js Button enum
 * value. The protocol intentionally uses the same numbering as the DOM
 * `MouseEvent.button` for left/middle/right, but the codomain here is the
 * nut.js enum so callers don't depend on that coincidence.
 */
export function mapButton(button: 0 | 1 | 2): NutButton {
  switch (button) {
    case 0:
      return 0; // LEFT
    case 1:
      return 1; // MIDDLE
    case 2:
      return 2; // RIGHT
    default:
      return 0;
  }
}

/** Decode a modifier bitflag set into its individual booleans. */
export function decodeModifiers(mods: number): {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
} {
  const m = mods | 0;
  return {
    shift: (m & MOD_SHIFT) !== 0,
    ctrl: (m & MOD_CTRL) !== 0,
    alt: (m & MOD_ALT) !== 0,
    meta: (m & MOD_META) !== 0,
  };
}

/**
 * The list of nut.js `Key` enum member names that should be held down for a
 * given modifier bitflag, in a stable order (ctrl, alt, shift, meta). These
 * names are resolved against the real `Key` enum at injection time.
 */
export function modifierKeyNames(mods: number): string[] {
  const m = decodeModifiers(mods);
  const names: string[] = [];
  if (m.ctrl) names.push('LeftControl');
  if (m.alt) names.push('LeftAlt');
  if (m.shift) names.push('LeftShift');
  if (m.meta) names.push('LeftSuper');
  return names;
}

/**
 * Translate a DOM `KeyboardEvent.code` (e.g. "KeyA", "Digit1", "ArrowLeft",
 * "Enter", "F5") into the corresponding nut.js `Key` enum member NAME. The name
 * is resolved against the real `Key` enum (`Key[name]`) at injection time, so
 * this function never touches the native library.
 *
 * Returns `null` for codes we can't map; the caller logs and skips those.
 */
export function mapKeyCode(code: string): string | null {
  // Letters: "KeyA".."KeyZ" -> "A".."Z"
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);

  // Top-row digits: "Digit0".."Digit9" -> "Num0".."Num9"
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return `Num${digit[1]}`;

  // Numpad digits: "Numpad0".."Numpad9" -> "NumPad0".."NumPad9"
  const np = /^Numpad([0-9])$/.exec(code);
  if (np) return `NumPad${np[1]}`;

  // Function keys: "F1".."F24"
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

  return KEY_CODE_MAP[code] ?? null;
}

/** Static map for non-pattern DOM codes -> nut.js Key enum member names. */
const KEY_CODE_MAP: Record<string, string> = {
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: 'Minus',
  Equal: 'Equal',
  BracketLeft: 'LeftBracket',
  BracketRight: 'RightBracket',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Backquote: 'Grave',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  CapsLock: 'CapsLock',
  NumpadAdd: 'Add',
  NumpadSubtract: 'Subtract',
  NumpadMultiply: 'Multiply',
  NumpadDivide: 'Divide',
  NumpadDecimal: 'Decimal',
  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift',
  ControlLeft: 'LeftControl',
  ControlRight: 'RightControl',
  AltLeft: 'LeftAlt',
  AltRight: 'RightAlt',
  MetaLeft: 'LeftSuper',
  MetaRight: 'RightSuper',
};

/* -------------------------------------------------------------------------- */
/*  Runtime injector (loads nut.js lazily; no-op if unavailable)              */
/* -------------------------------------------------------------------------- */

type NutModule = typeof import('@nut-tree-fork/nut-js');

/**
 * Wraps the optional native automation library. All public methods are safe to
 * call regardless of whether the library loaded: if it didn't, they warn once
 * and no-op. Coordinates arrive normalized (0..1) and are mapped to the live
 * screen size discovered from nut.js.
 */
export class InputInjector {
  private nut: NutModule | null = null;
  private loadAttempted = false;
  private warned = false;
  private screenSize: ScreenSize | null = null;

  /**
   * Attempt to load the native library. Idempotent and never throws. Returns
   * whether the library is available afterward.
   */
  async init(): Promise<boolean> {
    if (this.loadAttempted) return this.nut !== null;
    this.loadAttempted = true;
    try {
      // Dynamic import keeps the native dep out of the static module graph, so a
      // missing/failed install can't break `import`-time of the host bundle.
      this.nut = (await import('@nut-tree-fork/nut-js')) as NutModule;
      // Snappy, deterministic injection — no artificial delays between actions.
      this.nut.mouse.config.autoDelayMs = 0;
      this.nut.keyboard.config.autoDelayMs = 0;
      this.screenSize = {
        width: await this.nut.screen.width(),
        height: await this.nut.screen.height(),
      };
      return true;
    } catch (err) {
      this.warnOnce(err);
      this.nut = null;
      return false;
    }
  }

  /** Whether native injection is currently available. */
  get available(): boolean {
    return this.nut !== null;
  }

  /**
   * Re-query the host screen size (e.g. after a resolution change). Safe no-op
   * if the native lib is unavailable.
   */
  async refreshScreenSize(): Promise<void> {
    if (!this.nut) return;
    this.screenSize = {
      width: await this.nut.screen.width(),
      height: await this.nut.screen.height(),
    };
  }

  /** Inject a single decoded input event. Never throws. */
  async inject(e: InputEvent): Promise<void> {
    if (!this.nut) {
      this.warnOnce();
      return;
    }
    const nut = this.nut;
    const size = this.screenSize ?? { width: 1920, height: 1080 };
    try {
      switch (e.t) {
        case 'm-move': {
          const p = normalizedToPixels(e.x, e.y, size);
          await nut.mouse.setPosition(p);
          break;
        }
        case 'm-down': {
          await nut.mouse.setPosition(normalizedToPixels(e.x, e.y, size));
          await nut.mouse.pressButton(mapButton(e.button) as unknown as NutButtonEnum);
          break;
        }
        case 'm-up': {
          await nut.mouse.setPosition(normalizedToPixels(e.x, e.y, size));
          await nut.mouse.releaseButton(mapButton(e.button) as unknown as NutButtonEnum);
          break;
        }
        case 'm-wheel': {
          await nut.mouse.setPosition(normalizedToPixels(e.x, e.y, size));
          if (e.dy > 0) await nut.mouse.scrollDown(Math.abs(Math.round(e.dy)));
          else if (e.dy < 0) await nut.mouse.scrollUp(Math.abs(Math.round(e.dy)));
          if (e.dx > 0) await nut.mouse.scrollRight(Math.abs(Math.round(e.dx)));
          else if (e.dx < 0) await nut.mouse.scrollLeft(Math.abs(Math.round(e.dx)));
          break;
        }
        case 'k-down': {
          await this.holdModifiers(nut, e.mods, true);
          const keyName = mapKeyCode(e.code);
          if (keyName && !modifierKeyNames(e.mods).includes(keyName)) {
            const k = nut.Key[keyName];
            if (k !== undefined) await nut.keyboard.pressKey(k);
          }
          break;
        }
        case 'k-up': {
          const keyName = mapKeyCode(e.code);
          if (keyName && !modifierKeyNames(e.mods).includes(keyName)) {
            const k = nut.Key[keyName];
            if (k !== undefined) await nut.keyboard.releaseKey(k);
          }
          await this.holdModifiers(nut, e.mods, false);
          break;
        }
        case 'clipboard': {
          // Clipboard sync is handled in the main process (Electron clipboard);
          // see main.ts. Nothing to inject at the OS-automation layer.
          break;
        }
      }
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private async holdModifiers(nut: NutModule, mods: number, press: boolean): Promise<void> {
    for (const name of modifierKeyNames(mods)) {
      const k = nut.Key[name];
      if (k === undefined) continue;
      if (press) await nut.keyboard.pressKey(k);
      else await nut.keyboard.releaseKey(k);
    }
  }

  private warnOnce(err?: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const detail = err instanceof Error ? `: ${err.message}` : '';
    // eslint-disable-next-line no-console
    console.warn(
      `[input-injector] native input library "@nut-tree-fork/nut-js" unavailable${detail}. ` +
        'Remote input will be ignored on this machine. Install the optional dependency on the host to enable control.',
    );
  }
}

/**
 * The nut.js Button enum value type. The shim types it as an enum; at the call
 * sites above we pass plain numbers (0/1/2) and assert through this alias to
 * keep both the shim and the real package happy.
 */
type NutButtonEnum = import('@nut-tree-fork/nut-js').Button;
