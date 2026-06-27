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
import { execFile } from 'node:child_process';
import {
  normalizedToVirtualPixels,
  type DisplayGeometry,
  type VirtualPoint,
} from './monitor.js';

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
 * Decide whether an ordered {@link InputEvent} sequence is the Ctrl+Alt+Del
 * chord, so the host can route it to the real Windows Secure Attention Sequence
 * (SAS) API rather than replaying synthetic key presses (which the kernel
 * ignores for the SAS on a default Windows install).
 *
 * The match is intentionally loose: any combo whose key-down events include a
 * Delete press while BOTH Ctrl and Alt are held (per the `mods` bitfield)
 * qualifies. This matches {@link CTRL_ALT_DEL}/`buildKeyCombo(['ctrl','alt',
 * 'delete'])` regardless of event ordering, and ignores trailing `k-up`s.
 *
 * Pure and side-effect-free — unit-tested on Linux without the native libs.
 */
export function isCtrlAltDelCombo(events: InputEvent[]): boolean {
  for (const ev of events) {
    if (ev.t !== 'k-down') continue;
    const isDelete = ev.code === 'Delete' || ev.code === 'NumpadDecimal';
    if (!isDelete) continue;
    const m = decodeModifiers(ev.mods);
    if (m.ctrl && m.alt) return true;
  }
  return false;
}

/**
 * Translate a key identifier into the corresponding nut.js `Key` enum member
 * NAME. The name is resolved against the real `Key` enum (`Key[name]`) at
 * injection time, so this function never touches the native library.
 *
 * Two input vocabularies are accepted so the host agrees with the contract the
 * AI/viewer layers advertise:
 *
 *   1. DOM `KeyboardEvent.code` strings — "KeyA", "Digit1", "Numpad5",
 *      "ArrowLeft", "Enter", "F5". This is what the viewer's real keyboard
 *      capture emits.
 *   2. Single-character / bare names — "a", "A", "1", "!", "Enter", "Tab". This
 *      is what the AI `press_key` tool schema documents and produces (its
 *      examples include `'a'`), so a bare letter or digit MUST map. Single
 *      letters fold to their uppercase `Key` name ("a"/"A" -> "A") and single
 *      top-row digits map to "Num0".."Num9". Common shifted punctuation maps to
 *      the unshifted physical key (the caller is responsible for any Shift
 *      modifier); we deliberately do NOT try to inject the shift here because
 *      that would change the established modifier contract.
 *
 * Returns `null` for identifiers we can't map; the caller logs and skips those.
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

  const named = KEY_CODE_MAP[code];
  if (named) return named;

  // Bare single-character names (the AI `press_key` vocabulary). Letters fold to
  // their uppercase `Key` member; top-row digits map to "Num0".."Num9".
  if (code.length === 1) {
    if (/^[A-Za-z]$/.test(code)) return code.toUpperCase();
    if (/^[0-9]$/.test(code)) return `Num${code}`;
    const punct = PUNCT_CHAR_MAP[code];
    if (punct) return punct;
  }

  return null;
}

/**
 * Single punctuation characters -> the physical nut.js `Key` they live on. Both
 * the unshifted and the shifted glyph of a US-layout key map to the same
 * physical key (e.g. "1" and "!" both -> Num1, "/" and "?" both -> Slash); the
 * caller decides whether Shift is held. This lets `press_key key='/'` or
 * `press_key key=';'` produce a keystroke instead of silently no-opping.
 */
const PUNCT_CHAR_MAP: Record<string, string> = {
  ' ': 'Space',
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '[': 'LeftBracket',
  '{': 'LeftBracket',
  ']': 'RightBracket',
  '}': 'RightBracket',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  '`': 'Grave',
  '~': 'Grave',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash',
  '!': 'Num1',
  '@': 'Num2',
  '#': 'Num3',
  $: 'Num4',
  '%': 'Num5',
  '^': 'Num6',
  '&': 'Num7',
  '*': 'Num8',
  '(': 'Num9',
  ')': 'Num0',
};

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
  private sasWarned = false;
  private screenSize: ScreenSize | null = null;
  /**
   * Geometry (bounds + scaleFactor) of the display currently being SHARED. When
   * set, normalized pointer coords are translated into that display's
   * virtual-desktop pixel space — fixing aim on secondary/HiDPI monitors. When
   * null we fall back to primary-display pixel mapping via {@link screenSize}.
   */
  private displayGeometry: DisplayGeometry | null = null;

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

  /**
   * Set (or clear) the geometry of the display currently being shared. Called by
   * the main process whenever the host picks/switches a monitor, so subsequent
   * pointer events land on the RIGHT display in the right pixel space (the
   * multi-monitor / HiDPI fix). Pass `null` to revert to primary-display mapping.
   */
  setDisplayGeometry(geom: DisplayGeometry | null): void {
    this.displayGeometry = geom;
  }

  /** Whether a per-display geometry is currently configured. */
  get hasDisplayGeometry(): boolean {
    return this.displayGeometry !== null;
  }

  /**
   * Resolve a normalized (0..1) pointer coord to an absolute virtual-desktop
   * pixel point. Prefers the per-display geometry (correct for any
   * monitor/scale); falls back to primary-display pixels when no geometry is
   * set (e.g. a captured window, or before the main process plumbs geometry in).
   */
  private resolvePoint(x: number, y: number): VirtualPoint {
    if (this.displayGeometry) {
      return normalizedToVirtualPixels(x, y, this.displayGeometry);
    }
    const size = this.screenSize ?? { width: 1920, height: 1080 };
    return normalizedToPixels(x, y, size);
  }

  /** Inject a single decoded input event. Never throws. */
  async inject(e: InputEvent): Promise<void> {
    if (!this.nut) {
      this.warnOnce();
      return;
    }
    const nut = this.nut;
    try {
      switch (e.t) {
        case 'm-move': {
          await nut.mouse.setPosition(this.resolvePoint(e.x, e.y));
          break;
        }
        case 'm-down': {
          await nut.mouse.setPosition(this.resolvePoint(e.x, e.y));
          await nut.mouse.pressButton(mapButton(e.button) as unknown as NutButtonEnum);
          break;
        }
        case 'm-up': {
          await nut.mouse.setPosition(this.resolvePoint(e.x, e.y));
          await nut.mouse.releaseButton(mapButton(e.button) as unknown as NutButtonEnum);
          break;
        }
        case 'm-wheel': {
          await nut.mouse.setPosition(this.resolvePoint(e.x, e.y));
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
          // The text is written into Electron's clipboard in the main process,
          // which then calls paste() to inject Ctrl+V (see main.ts). Nothing to
          // do here at the per-event OS-automation layer.
          break;
        }
      }
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /**
   * Paste the current system clipboard into the focused application by
   * synthesizing the Ctrl+V chord. Called by the main process AFTER it has
   * written the text into Electron's clipboard for a `clipboard` input event
   * (the AI `type_text` tool). Without this, type_text would only replace the
   * clipboard and type nothing into the focused field. Safe no-op if the native
   * lib is unavailable. Never throws.
   *
   * Ctrl+V is the universal Windows/X11 paste shortcut for normal text fields;
   * terminals (Ctrl+Shift+V) are the known exception, but Ctrl+V is the correct
   * default for the overwhelming majority of GUI apps the AI drives.
   */
  async paste(): Promise<void> {
    if (!this.nut) {
      this.warnOnce();
      return;
    }
    const nut = this.nut;
    try {
      const ctrl = nut.Key.LeftControl;
      const v = nut.Key.V;
      if (ctrl === undefined || v === undefined) return;
      await nut.keyboard.pressKey(ctrl);
      await nut.keyboard.pressKey(v);
      await nut.keyboard.releaseKey(v);
      await nut.keyboard.releaseKey(ctrl);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /**
   * Inject an ordered sequence of {@link InputEvent}s atomically-ish (each is
   * awaited in turn). Used for special-key chords such as Ctrl+Alt+Del, Win+R,
   * Alt+Tab — the viewer sends the chord as a pre-built event list (see core
   * {@link SPECIAL_KEYS}/{@link buildKeyCombo}) and the host replays it here.
   *
   * Ctrl+Alt+Del is special-cased: synthetic key presses (nut.js or any other
   * user-space SendInput) CANNOT trigger the Windows Secure Attention Sequence
   * (SAS) — the kernel only honors SAS from a hardware interrupt or the
   * `SendSAS` API gated by the "SoftwareSASGeneration" policy. We therefore try
   * the real {@link sendSAS} path first; only if it is unavailable/fails do we
   * fall back to replaying the synthetic chord (still useful for in-app
   * shortcuts and for relaxed/kiosk Windows configs).
   */
  async injectCombo(events: InputEvent[]): Promise<void> {
    if (isCtrlAltDelCombo(events)) {
      const sent = await this.sendSAS();
      if (sent) return;
      // Fall through to the synthetic replay below as a best-effort fallback.
    }
    for (const ev of events) {
      await this.inject(ev);
    }
  }

  /**
   * Invoke the real Windows Secure Attention Sequence (Ctrl+Alt+Del) via the
   * documented `SendSAS` API in `sas.dll`. This is the only user-space way to
   * reach the secure desktop / logon UI; a plain key chord is ignored by the
   * kernel for the SAS.
   *
   * Requirements on the host: the "SoftwareSASGeneration" group policy
   * (Computer Configuration → Administrative Templates → Windows Components →
   * Windows Logon Options) must permit software-generated SAS — otherwise
   * `SendSAS` no-ops. We call it through PowerShell's Add-Type P/Invoke so the
   * host needs no extra native dependency.
   *
   * Returns `true` if the SAS was dispatched, `false` if unavailable (non-
   * Windows, PowerShell missing, policy disabled, or any error). Never throws.
   */
  async sendSAS(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    // P/Invoke SendSAS(bool AsUser). Passing $false requests the secure
    // (winlogon) SAS — the genuine Ctrl+Alt+Del experience.
    const script = [
      '$sig = @"',
      '[System.Runtime.InteropServices.DllImport("sas.dll", SetLastError=true)]',
      'public static extern void SendSAS(bool AsUser);',
      '"@',
      'Add-Type -MemberDefinition $sig -Namespace StreamScreen -Name Sas -PassThru | Out-Null',
      '[StreamScreen.Sas]::SendSAS($false)',
    ].join('\n');
    return await new Promise<boolean>((resolve) => {
      try {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { windowsHide: true, timeout: 5000 },
          (err) => {
            if (err) this.warnSASOnce(err);
            resolve(!err);
          },
        );
      } catch (err) {
        this.warnSASOnce(err);
        resolve(false);
      }
    });
  }

  private async holdModifiers(nut: NutModule, mods: number, press: boolean): Promise<void> {
    for (const name of modifierKeyNames(mods)) {
      const k = nut.Key[name];
      if (k === undefined) continue;
      if (press) await nut.keyboard.pressKey(k);
      else await nut.keyboard.releaseKey(k);
    }
  }

  private warnSASOnce(err?: unknown): void {
    if (this.sasWarned) return;
    this.sasWarned = true;
    const detail = err instanceof Error ? `: ${err.message}` : '';
    // eslint-disable-next-line no-console
    console.warn(
      `[input-injector] could not invoke the Windows Secure Attention Sequence (SendSAS)${detail}. ` +
        'Ctrl+Alt+Del fell back to a synthetic key chord, which the kernel ignores for the secure ' +
        'desktop. Enable the "SoftwareSASGeneration" policy on the host to allow remote Ctrl+Alt+Del.',
    );
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
