import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InputEvent } from '@stream-screen/core';
import {
  InputCapture,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  mapButton,
  modsFrom,
  normalizePointer,
  normalizeWheel,
  type VideoGeometry,
} from './input-capture.js';

describe('modsFrom — modifier bitflags', () => {
  it('packs each modifier into its flag', () => {
    expect(modsFrom({ shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })).toBe(MOD_SHIFT);
    expect(modsFrom({ shiftKey: false, ctrlKey: true, altKey: false, metaKey: false })).toBe(MOD_CTRL);
    expect(modsFrom({ shiftKey: false, ctrlKey: false, altKey: true, metaKey: false })).toBe(MOD_ALT);
    expect(modsFrom({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: true })).toBe(MOD_META);
  });

  it('matches the protocol flag values exactly', () => {
    expect([MOD_SHIFT, MOD_CTRL, MOD_ALT, MOD_META]).toEqual([1, 2, 4, 8]);
  });

  it('combines modifiers with bitwise OR', () => {
    expect(modsFrom({ shiftKey: true, ctrlKey: true, altKey: false, metaKey: false })).toBe(3);
    expect(modsFrom({ shiftKey: true, ctrlKey: true, altKey: true, metaKey: true })).toBe(15);
    expect(modsFrom({ shiftKey: false, ctrlKey: true, altKey: false, metaKey: true })).toBe(
      MOD_CTRL | MOD_META,
    );
  });

  it('is zero when no modifiers are held', () => {
    expect(modsFrom({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })).toBe(0);
  });
});

describe('mapButton — DOM button mapping', () => {
  it('maps left/middle/right to 0/1/2', () => {
    expect(mapButton(0)).toBe(0);
    expect(mapButton(1)).toBe(1);
    expect(mapButton(2)).toBe(2);
  });

  it('collapses unmodeled buttons (back/forward) to left-click', () => {
    expect(mapButton(3)).toBe(0);
    expect(mapButton(4)).toBe(0);
    expect(mapButton(-1)).toBe(0);
  });
});

describe('normalizePointer — coordinate normalization 0..1', () => {
  // A perfectly fitting 1000x500 video in a 1000x500 box (same aspect → no bars).
  const exact: VideoGeometry = {
    intrinsicWidth: 1000,
    intrinsicHeight: 500,
    rect: { left: 0, top: 0, width: 1000, height: 500 },
  };

  it('maps corners and center to 0..1', () => {
    expect(normalizePointer(0, 0, exact)).toEqual({ x: 0, y: 0 });
    expect(normalizePointer(1000, 500, exact)).toEqual({ x: 1, y: 1 });
    expect(normalizePointer(500, 250, exact)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clamps points outside the rendered area to [0,1]', () => {
    expect(normalizePointer(-200, -50, exact)).toEqual({ x: 0, y: 0 });
    expect(normalizePointer(5000, 5000, exact)).toEqual({ x: 1, y: 1 });
  });

  it('accounts for letterboxing when box is taller than the video (object-fit: contain)', () => {
    // 1000x500 (2:1) video shown in a 1000x1000 box → content is 1000x500,
    // centered vertically with 250px bars top and bottom.
    const letterboxed: VideoGeometry = {
      intrinsicWidth: 1000,
      intrinsicHeight: 500,
      rect: { left: 0, top: 0, width: 1000, height: 1000 },
    };
    // Vertical center of the box (500) is the vertical center of the content.
    expect(normalizePointer(500, 500, letterboxed)).toEqual({ x: 0.5, y: 0.5 });
    // Top edge of content sits at y=250 in the box.
    expect(normalizePointer(0, 250, letterboxed)).toEqual({ x: 0, y: 0 });
    // Bottom edge of content sits at y=750 in the box.
    expect(normalizePointer(1000, 750, letterboxed)).toEqual({ x: 1, y: 1 });
  });

  it('accounts for pillarboxing when box is wider than the video', () => {
    // 500x1000 (1:2) video in a 1000x1000 box → content 500x1000, 250px bars
    // left and right.
    const pillarboxed: VideoGeometry = {
      intrinsicWidth: 500,
      intrinsicHeight: 1000,
      rect: { left: 0, top: 0, width: 1000, height: 1000 },
    };
    expect(normalizePointer(500, 500, pillarboxed)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePointer(250, 0, pillarboxed)).toEqual({ x: 0, y: 0 });
    expect(normalizePointer(750, 1000, pillarboxed)).toEqual({ x: 1, y: 1 });
  });

  it('respects a non-zero element offset (rect.left/top)', () => {
    const offset: VideoGeometry = {
      intrinsicWidth: 100,
      intrinsicHeight: 100,
      rect: { left: 200, top: 100, width: 100, height: 100 },
    };
    expect(normalizePointer(200, 100, offset)).toEqual({ x: 0, y: 0 });
    expect(normalizePointer(250, 150, offset)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePointer(300, 200, offset)).toEqual({ x: 1, y: 1 });
  });

  it('returns {0,0} instead of NaN for degenerate geometry', () => {
    expect(
      normalizePointer(10, 10, {
        intrinsicWidth: 0,
        intrinsicHeight: 0,
        rect: { left: 0, top: 0, width: 0, height: 0 },
      }),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe('normalizeWheel — wheel delta normalization', () => {
  it('passes pixel deltas through unchanged (DOM_DELTA_PIXEL)', () => {
    expect(normalizeWheel(3, -10, 0)).toEqual({ dx: 3, dy: -10 });
  });

  it('scales line deltas (~16px per line, DOM_DELTA_LINE)', () => {
    expect(normalizeWheel(0, 2, 1)).toEqual({ dx: 0, dy: 32 });
    expect(normalizeWheel(-1, 0, 1)).toEqual({ dx: -16, dy: 0 });
  });

  it('scales page deltas by the page height (DOM_DELTA_PAGE)', () => {
    expect(normalizeWheel(0, 1, 2, 600)).toEqual({ dx: 0, dy: 600 });
    expect(normalizeWheel(0, -2, 2, 500)).toEqual({ dx: 0, dy: -1000 });
  });

  it('preserves delta sign (scroll direction)', () => {
    const up = normalizeWheel(0, -5, 0);
    const down = normalizeWheel(0, 5, 0);
    expect(up.dy).toBeLessThan(0);
    expect(down.dy).toBeGreaterThan(0);
  });
});

describe('InputCapture — event emission', () => {
  let video: HTMLVideoElement;
  let sent: InputEvent[];
  let capture: InputCapture;
  let clock: number;

  beforeEach(() => {
    sent = [];
    clock = 0;
    video = document.createElement('video');
    // jsdom returns a zero rect; stub a known geometry and intrinsic size.
    video.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(video, 'videoWidth', { value: 1000, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 500, configurable: true });
    capture = new InputCapture({
      video,
      send: (e) => sent.push(e),
      moveThrottleMs: 8,
      now: () => clock,
    });
    capture.attach();
  });

  afterEach(() => {
    capture.detach();
  });

  it('emits a normalized m-move on mousemove', () => {
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 250 }));
    expect(sent).toEqual([{ t: 'm-move', x: 0.5, y: 0.5 }]);
  });

  it('throttles mousemove to the configured interval (~120Hz)', () => {
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 50 }));
    // Within the throttle window → dropped.
    clock = 4;
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 100 }));
    // Past the window → emitted.
    clock = 12;
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 150 }));
    expect(sent).toHaveLength(2);
    expect(sent.every((e) => e.t === 'm-move')).toBe(true);
  });

  it('emits m-down / m-up with mapped buttons and coords', () => {
    video.dispatchEvent(new MouseEvent('mousedown', { clientX: 1000, clientY: 500, button: 2 }));
    video.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, button: 0 }));
    expect(sent).toEqual([
      { t: 'm-down', x: 1, y: 1, button: 2 },
      { t: 'm-up', x: 0, y: 0, button: 0 },
    ]);
  });

  it('emits m-wheel with normalized deltas', () => {
    const wheel = new WheelEvent('wheel', { clientX: 500, clientY: 250, deltaX: 0, deltaY: 3, deltaMode: 0 });
    video.dispatchEvent(wheel);
    expect(sent).toEqual([{ t: 'm-wheel', x: 0.5, y: 0.5, dx: 0, dy: 3 }]);
  });

  it('emits k-down / k-up with code, key and packed mods', () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', ctrlKey: true, shiftKey: true }),
    );
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'a' }));
    expect(sent).toEqual([
      { t: 'k-down', code: 'KeyA', key: 'a', mods: MOD_CTRL | MOD_SHIFT },
      { t: 'k-up', code: 'KeyA', key: 'a', mods: 0 },
    ]);
  });

  it('stops emitting after detach', () => {
    capture.detach();
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 250 }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b' }));
    expect(sent).toEqual([]);
  });

  it('mirrors host clipboard text into the local clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await capture.applyClipboardFromHost('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
  });
});
