import { describe, it, expect } from 'vitest';
import {
  isControlMessage,
  buildKeyCombo,
  CTRL_ALT_DEL,
  SPECIAL_KEYS,
  KEY_MODS,
} from '../src/protocol.js';
import type { ControlMessage, InputEvent } from '../src/protocol.js';

describe('isControlMessage', () => {
  const valid: ControlMessage[] = [
    { t: 'chat', text: 'hi', ts: 1 },
    { t: 'monitors', list: [] },
    { t: 'monitors', list: [{ id: 'a', name: 'Display 1', primary: true, width: 1920, height: 1080 }] },
    { t: 'switch-monitor', id: 'a' },
    { t: 'monitor-switched', id: 'a' },
    { t: 'request-monitors' },
    { t: 'file-offer', id: '1', name: 'f.txt', size: 10, mime: 'text/plain' },
    { t: 'file-accept', id: '1' },
    { t: 'file-reject', id: '1' },
    { t: 'file-progress', id: '1', received: 5 },
    { t: 'file-complete', id: '1' },
    { t: 'file-error', id: '1', message: 'boom' },
    { t: 'audio', enabled: true },
    { t: 'audio', enabled: false },
    { t: 'quality', preset: 'auto' },
    { t: 'quality', preset: 'low' },
    { t: 'latency', rttMs: 30, playoutMs: 12 },
    { t: 'latency', rttMs: 30, playoutMs: 12, fps: 60 },
    { t: 'latency', rttMs: 0, playoutMs: 0 },
  ];

  it('accepts every well-formed control message', () => {
    for (const m of valid) expect(isControlMessage(m)).toBe(true);
  });

  it('round-trips through JSON', () => {
    for (const m of valid) {
      expect(isControlMessage(JSON.parse(JSON.stringify(m)))).toBe(true);
    }
  });

  it('rejects non-objects and unknown discriminants', () => {
    expect(isControlMessage(null)).toBe(false);
    expect(isControlMessage(undefined)).toBe(false);
    expect(isControlMessage(42)).toBe(false);
    expect(isControlMessage('chat')).toBe(false);
    expect(isControlMessage({})).toBe(false);
    expect(isControlMessage({ t: 'nope' })).toBe(false);
  });

  it('rejects messages with missing/wrong-typed fields', () => {
    expect(isControlMessage({ t: 'chat', text: 'hi' })).toBe(false); // no ts
    expect(isControlMessage({ t: 'chat', text: 1, ts: 1 })).toBe(false);
    expect(isControlMessage({ t: 'file-offer', id: '1', name: 'f', size: 'big', mime: 'x' })).toBe(false);
    expect(isControlMessage({ t: 'file-progress', id: '1' })).toBe(false);
    expect(isControlMessage({ t: 'audio', enabled: 'yes' })).toBe(false);
    expect(isControlMessage({ t: 'quality', preset: 'ultra' })).toBe(false);
    expect(isControlMessage({ t: 'monitors', list: [{ id: 'a' }] })).toBe(false);
    expect(isControlMessage({ t: 'monitors', list: 'nope' })).toBe(false);
    expect(isControlMessage({ t: 'switch-monitor' })).toBe(false);
  });

  it('accepts auth-challenge in pin / pin-and-prompt / prompt shapes', () => {
    const pinFields = {
      nonceH: 'bm9uY2U=',
      salt: 'c2FsdA==',
      iterations: 100_000,
      channelBinding: 'YmluZGluZw==',
    };
    // PIN modes require the full proof material.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'pin', ...pinFields })).toBe(true);
    expect(
      isControlMessage({ t: 'auth-challenge', v: 1, mode: 'pin-and-prompt', ...pinFields }),
    ).toBe(true);
    // `mode` is optional and defaults to 'pin' for back-compat: a legacy
    // challenge with no `mode` but full PIN fields is still accepted.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, ...pinFields })).toBe(true);
    // Prompt mode needs NO PIN fields — the challenge only flips the viewer into
    // the "waiting for host approval" state.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'prompt' })).toBe(true);
    // Prompt mode tolerates PIN fields if a sender still includes them.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'prompt', ...pinFields })).toBe(
      true,
    );
    // A host re-sending a FRESH challenge for a retry is just another valid
    // auth-challenge (new nonce, same PIN mode).
    expect(
      isControlMessage({ t: 'auth-challenge', v: 1, mode: 'pin', ...pinFields, nonceH: 'ZnJlc2g=' }),
    ).toBe(true);
  });

  it('rejects malformed auth-challenge messages', () => {
    const pinFields = {
      nonceH: 'bm9uY2U=',
      salt: 'c2FsdA==',
      iterations: 100_000,
      channelBinding: 'YmluZGluZw==',
    };
    // Wrong protocol version.
    expect(isControlMessage({ t: 'auth-challenge', v: 2, mode: 'pin', ...pinFields })).toBe(false);
    // Unknown mode.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'nope', ...pinFields })).toBe(false);
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 42, ...pinFields })).toBe(false);
    // PIN mode missing required proof material.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'pin' })).toBe(false);
    const { nonceH: _omit, ...noNonce } = pinFields;
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'pin', ...noNonce })).toBe(false);
    // Default (no mode -> 'pin') also requires the PIN fields.
    expect(isControlMessage({ t: 'auth-challenge', v: 1 })).toBe(false);
    // Wrong-typed PIN fields are rejected even in pin mode.
    expect(
      isControlMessage({ t: 'auth-challenge', v: 1, mode: 'pin', ...pinFields, iterations: 'lots' }),
    ).toBe(false);
    // Prompt mode with a wrong-typed (present) PIN field is rejected.
    expect(isControlMessage({ t: 'auth-challenge', v: 1, mode: 'prompt', nonceH: 5 })).toBe(false);
  });

  it('accepts a valid latency telemetry message and rejects malformed ones', () => {
    expect(isControlMessage({ t: 'latency', rttMs: 25, playoutMs: 10 })).toBe(true);
    expect(isControlMessage({ t: 'latency', rttMs: 25, playoutMs: 10, fps: 30 })).toBe(true);
    // Missing required numeric fields.
    expect(isControlMessage({ t: 'latency', rttMs: 25 })).toBe(false);
    expect(isControlMessage({ t: 'latency', playoutMs: 10 })).toBe(false);
    expect(isControlMessage({ t: 'latency' })).toBe(false);
    // Wrong-typed required fields.
    expect(isControlMessage({ t: 'latency', rttMs: '25', playoutMs: 10 })).toBe(false);
    expect(isControlMessage({ t: 'latency', rttMs: 25, playoutMs: 'x' })).toBe(false);
    // Non-finite numbers rejected.
    expect(isControlMessage({ t: 'latency', rttMs: NaN, playoutMs: 10 })).toBe(false);
    expect(isControlMessage({ t: 'latency', rttMs: 25, playoutMs: Infinity })).toBe(false);
    // Optional fps, when present, must be a finite number.
    expect(isControlMessage({ t: 'latency', rttMs: 25, playoutMs: 10, fps: 'fast' })).toBe(false);
    expect(isControlMessage({ t: 'latency', rttMs: 25, playoutMs: 10, fps: NaN })).toBe(false);
  });
});

describe('buildKeyCombo / CTRL_ALT_DEL', () => {
  it('returns empty for empty input', () => {
    expect(buildKeyCombo([])).toEqual([]);
  });

  it('presses in order then releases in reverse, with cumulative mods', () => {
    const combo = buildKeyCombo(['ctrl', 'alt', 'delete']);
    // 3 down + 3 up.
    expect(combo).toHaveLength(6);
    const downs = combo.slice(0, 3);
    const ups = combo.slice(3);
    expect(downs.every((e) => e.t === 'k-down')).toBe(true);
    expect(ups.every((e) => e.t === 'k-up')).toBe(true);

    // Every event carries the full ctrl|alt mask.
    const expectedMods = KEY_MODS.ctrl | KEY_MODS.alt;
    for (const e of combo) {
      if (e.t === 'k-down' || e.t === 'k-up') expect(e.mods).toBe(expectedMods);
    }

    // Press order ctrl, alt, delete; release order delete, alt, ctrl.
    const codes = (evs: InputEvent[]) =>
      evs.map((e) => (e.t === 'k-down' || e.t === 'k-up' ? e.code : ''));
    expect(codes(downs)).toEqual(['ControlLeft', 'AltLeft', 'Delete']);
    expect(codes(ups)).toEqual(['Delete', 'AltLeft', 'ControlLeft']);
  });

  it('CTRL_ALT_DEL is the canonical ctrl+alt+delete combo', () => {
    expect(CTRL_ALT_DEL).toEqual(buildKeyCombo(['ctrl', 'alt', 'delete']));
    const down = CTRL_ALT_DEL.find((e) => e.t === 'k-down' && e.code === 'Delete');
    expect(down).toBeDefined();
  });

  it('maps the Win key to a meta modifier', () => {
    const win = SPECIAL_KEYS.WIN;
    expect(win).toHaveLength(2);
    const first = win[0];
    expect(first.t).toBe('k-down');
    if (first.t === 'k-down') {
      expect(first.code).toBe('MetaLeft');
      expect(first.mods).toBe(KEY_MODS.meta);
    }
  });

  it('builds arbitrary modifier+key combos (e.g. Win+R)', () => {
    const combo = buildKeyCombo(['win', 'r']);
    expect(combo).toHaveLength(4);
    const rDown = combo.find((e) => e.t === 'k-down' && e.key === 'r');
    expect(rDown).toBeDefined();
    if (rDown && rDown.t === 'k-down') {
      expect(rDown.code).toBe('KeyR');
      expect(rDown.mods).toBe(KEY_MODS.meta);
    }
  });
});
