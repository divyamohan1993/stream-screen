import type { InputEvent } from './protocol.js';

/**
 * Wire codec for {@link InputEvent}s sent over the WebRTC input data channel.
 *
 * The wire format is compact JSON. The `t` discriminant is preserved verbatim
 * so the decoder can reconstruct the exact union member, and numeric fields are
 * rounded on the way out to keep pointer-move spam small without losing the
 * resolution-independent precision the host needs (4 decimal places ≈ sub-pixel
 * on a 4K display). The codec is pure and round-trip safe for every variant.
 */

/** Round a normalized coordinate to 4 decimals to trim wire size. */
function r4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Serialize an {@link InputEvent} to a compact wire string.
 *
 * @throws if `e` is not a recognized {@link InputEvent} variant.
 */
export function encodeInput(e: InputEvent): string {
  switch (e.t) {
    case 'm-move':
      return JSON.stringify({ t: e.t, x: r4(e.x), y: r4(e.y) });
    case 'm-down':
    case 'm-up':
      return JSON.stringify({ t: e.t, x: r4(e.x), y: r4(e.y), b: e.button });
    case 'm-wheel':
      return JSON.stringify({ t: e.t, x: r4(e.x), y: r4(e.y), dx: e.dx, dy: e.dy });
    case 'k-down':
    case 'k-up':
      return JSON.stringify({ t: e.t, c: e.code, k: e.key, m: e.mods });
    case 'clipboard':
      return JSON.stringify({ t: e.t, x: e.text });
    default: {
      // Exhaustiveness guard: if a new variant is added the compiler flags this.
      const _never: never = e;
      throw new TypeError(`encodeInput: unknown input event ${JSON.stringify(_never)}`);
    }
  }
}

/** Narrowing helper for a button value. */
function asButton(v: unknown): 0 | 1 | 2 {
  if (v === 0 || v === 1 || v === 2) return v;
  throw new TypeError(`decodeInput: invalid button ${String(v)}`);
}

function asNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`decodeInput: field ${field} is not a finite number`);
  }
  return v;
}

function asStr(v: unknown, field: string): string {
  if (typeof v !== 'string') {
    throw new TypeError(`decodeInput: field ${field} is not a string`);
  }
  return v;
}

/**
 * Parse a wire string produced by {@link encodeInput} back into an
 * {@link InputEvent}.
 *
 * @throws if the payload is malformed or of an unknown type.
 */
export function decodeInput(s: string): InputEvent {
  const o = JSON.parse(s) as Record<string, unknown>;
  if (o === null || typeof o !== 'object') {
    throw new TypeError('decodeInput: payload is not an object');
  }
  switch (o.t) {
    case 'm-move':
      return { t: 'm-move', x: asNum(o.x, 'x'), y: asNum(o.y, 'y') };
    case 'm-down':
      return { t: 'm-down', x: asNum(o.x, 'x'), y: asNum(o.y, 'y'), button: asButton(o.b) };
    case 'm-up':
      return { t: 'm-up', x: asNum(o.x, 'x'), y: asNum(o.y, 'y'), button: asButton(o.b) };
    case 'm-wheel':
      return {
        t: 'm-wheel',
        x: asNum(o.x, 'x'),
        y: asNum(o.y, 'y'),
        dx: asNum(o.dx, 'dx'),
        dy: asNum(o.dy, 'dy'),
      };
    case 'k-down':
      return { t: 'k-down', code: asStr(o.c, 'code'), key: asStr(o.k, 'key'), mods: asNum(o.m, 'mods') };
    case 'k-up':
      return { t: 'k-up', code: asStr(o.c, 'code'), key: asStr(o.k, 'key'), mods: asNum(o.m, 'mods') };
    case 'clipboard':
      return { t: 'clipboard', text: asStr(o.x, 'text') };
    default:
      throw new TypeError(`decodeInput: unknown input event type ${String(o.t)}`);
  }
}
