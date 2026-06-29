import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InputEvent } from '@stream-screen/core';
import {
  InputCapture,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  contentBox,
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
    // Connect to the document so events dispatched on the stage bubble to the
    // document-level key listeners (mirrors the real DOM tree).
    document.body.appendChild(video);
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
    video.remove();
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

  it('ignores keydown/keyup whose target is an editable element (chat box / inputs)', () => {
    // Regression for CODEX P2: document-level key listeners also fire while the
    // user types in the viewer's own UI. A keystroke targeting an <input> must
    // NOT be forwarded to the host and must NOT be preventDefault'd, so local
    // editing keeps working.
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const down = new KeyboardEvent('keydown', { code: 'KeyH', key: 'h', bubbles: true, cancelable: true });
      input.dispatchEvent(down);
      const up = new KeyboardEvent('keyup', { code: 'KeyH', key: 'h', bubbles: true, cancelable: true });
      input.dispatchEvent(up);
      // Not forwarded to the host…
      expect(sent).toEqual([]);
      // …and not preventDefault'd, so the character still lands in the field.
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
    } finally {
      input.remove();
    }
  });

  it('ignores keydown targeting a contenteditable element', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    // jsdom doesn't fully implement contenteditable focus; force the flag.
    Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(editable);
    try {
      const down = new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true, cancelable: true });
      editable.dispatchEvent(down);
      expect(sent).toEqual([]);
      expect(down.defaultPrevented).toBe(false);
    } finally {
      editable.remove();
    }
  });

  it('forwards and preventDefaults a keydown targeting the video stage', () => {
    const down = new KeyboardEvent('keydown', {
      code: 'KeyA',
      key: 'a',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    // Target the video stage directly (real remote-control keystroke).
    video.dispatchEvent(down);
    expect(sent).toEqual([{ t: 'k-down', code: 'KeyA', key: 'a', mods: MOD_CTRL | MOD_ALT }]);
    expect(down.defaultPrevented).toBe(true);
  });

  it('still forwards the Ctrl+Alt+Del combo keystrokes from the stage', () => {
    const del = new KeyboardEvent('keydown', {
      code: 'Delete',
      key: 'Delete',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    video.dispatchEvent(del);
    expect(sent).toEqual([{ t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_CTRL | MOD_ALT }]);
    expect(del.defaultPrevented).toBe(true);
  });

  it('stops emitting after detach', () => {
    capture.detach();
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 250 }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b' }));
    expect(sent).toEqual([]);
  });

  it('fires the local-cursor callback unthrottled with viewport coords', () => {
    // Use a fresh capture/video so the shared beforeEach instance doesn't also
    // emit on these same DOM events.
    capture.detach();
    sent = [];
    const cursors: Array<{ x: number; y: number }> = [];
    const cap = new InputCapture({
      video,
      send: (e) => sent.push(e),
      moveThrottleMs: 8,
      now: () => clock,
      onLocalCursor: (x, y) => cursors.push({ x, y }),
    });
    cap.attach();
    try {
      // Three moves within the SAME throttle window: the data-channel m-move is
      // emitted once, but the local cursor must update on every move.
      video.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 50 }));
      video.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 100 }));
      video.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 150 }));
      expect(sent.filter((e) => e.t === 'm-move')).toHaveLength(1);
      expect(cursors).toEqual([
        { x: 100, y: 50 },
        { x: 200, y: 100 },
        { x: 300, y: 150 },
      ]);
    } finally {
      cap.detach();
    }
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

  // FINDING B regression: a drag that begins on the video but is RELEASED
  // outside the element (over the toolbar / past the edge) must still forward an
  // m-up, otherwise the host injector leaves the remote button held.
  it('forwards m-up for a mouseup dispatched on document outside the video', () => {
    video.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, clientY: 250, button: 0 }));
    // The release lands on the document, NOT on the video element (drag ended
    // off-stage). The document-level fallback must still capture it.
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, button: 0 }));
    expect(sent).toEqual([
      { t: 'm-down', x: 0.5, y: 0.5, button: 0 },
      { t: 'm-up', x: 0, y: 0, button: 0 },
    ]);
  });

  it('does not double-send m-up when the release happens over the video (bubbles to document)', () => {
    video.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, clientY: 250, button: 0 }));
    // A real release over the video both fires the element listener and bubbles
    // to the document listener; only ONE m-up may be sent.
    video.dispatchEvent(new MouseEvent('mouseup', { clientX: 500, clientY: 250, button: 0, bubbles: true }));
    expect(sent.filter((e) => e.t === 'm-up')).toEqual([{ t: 'm-up', x: 0.5, y: 0.5, button: 0 }]);
  });

  it('ignores an outside mouseup with no matching pressed button', () => {
    // No mousedown was forwarded for this button, so a stray document mouseup
    // (e.g. interacting with the viewer UI) must NOT fabricate an m-up.
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, button: 0 }));
    expect(sent).toEqual([]);
  });

  it('forwards the correct button for a multi-button drag released outside', () => {
    video.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, clientY: 250, button: 2 }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: -50, clientY: -50, button: 2 }));
    expect(sent).toEqual([
      { t: 'm-down', x: 0.5, y: 0.5, button: 2 },
      { t: 'm-up', x: 0, y: 0, button: 2 },
    ]);
  });

  it('stops capturing outside-release mouseups after detach', () => {
    video.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, clientY: 250, button: 0 }));
    capture.detach();
    sent = [];
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, button: 0 }));
    expect(sent).toEqual([]);
  });
});

describe('InputCapture — pointer-lock relative delta scaling (FINDING A)', () => {
  let video: HTMLVideoElement;
  let sent: InputEvent[];
  let capture: InputCapture;
  let clock: number;

  beforeEach(() => {
    sent = [];
    clock = 0;
    video = document.createElement('video');
    // Remote screen is 1920x1080 intrinsic, but the element is RENDERED at half
    // that size (960x540) — exactly the responsive/fullscreen mismatch the bug
    // is about. Same aspect ratio so there is no letterboxing; the content box
    // equals the CSS box (960x540).
    video.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
    document.body.appendChild(video);
    capture = new InputCapture({
      video,
      send: (e) => sent.push(e),
      moveThrottleMs: 0,
      now: () => clock,
    });
    capture.attach();
  });

  afterEach(() => {
    capture.detach();
    video.remove();
    Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
  });

  it('scales movementX/Y by the RENDERED content box, not the intrinsic size', () => {
    // Engage pointer lock on the video.
    Object.defineProperty(document, 'pointerLockElement', { value: video, configurable: true });
    // Reset the accumulated lock position to a known origin so the delta is
    // unambiguous: a free (unlocked) move at the top-left content corner.
    Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }));
    sent = [];
    Object.defineProperty(document, 'pointerLockElement', { value: video, configurable: true });

    // movementX of 96 CSS px against the RENDERED 960px-wide box is 96/960 = 0.1
    // of the host screen width — NOT 96/1920 = 0.05 (the intrinsic-size bug).
    const move = new MouseEvent('mousemove', { clientX: 0, clientY: 0 });
    Object.defineProperty(move, 'movementX', { value: 96, configurable: true });
    Object.defineProperty(move, 'movementY', { value: 0, configurable: true });
    video.dispatchEvent(move);

    const last = sent.filter((e) => e.t === 'm-move').at(-1);
    expect(last).toBeDefined();
    if (last && last.t === 'm-move') {
      expect(last.x).toBeCloseTo(0.1, 6);
      expect(last.x).not.toBeCloseTo(0.05, 6);
      expect(last.y).toBeCloseTo(0, 6);
    }
  });

  it('scales vertical movement by the rendered content box height', () => {
    Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
    video.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }));
    sent = [];
    Object.defineProperty(document, 'pointerLockElement', { value: video, configurable: true });

    // movementY of 54 px against the rendered 540px-tall box is 54/540 = 0.1,
    // not 54/1080 = 0.05.
    const move = new MouseEvent('mousemove', { clientX: 0, clientY: 0 });
    Object.defineProperty(move, 'movementX', { value: 0, configurable: true });
    Object.defineProperty(move, 'movementY', { value: 54, configurable: true });
    video.dispatchEvent(move);

    const last = sent.filter((e) => e.t === 'm-move').at(-1);
    if (last && last.t === 'm-move') {
      expect(last.y).toBeCloseTo(0.1, 6);
      expect(last.y).not.toBeCloseTo(0.05, 6);
    }
  });
});

describe('contentBox — rendered object-fit:contain rectangle', () => {
  it('equals the CSS box when aspect ratios match', () => {
    expect(
      contentBox({
        intrinsicWidth: 1920,
        intrinsicHeight: 1080,
        rect: { left: 0, top: 0, width: 960, height: 540 },
      }),
    ).toEqual({ left: 0, top: 0, width: 960, height: 540 });
  });

  it('shrinks height and centers vertically when letterboxed', () => {
    // 1000x500 (2:1) in a 1000x1000 box → 1000x500 content, 250px top/bottom.
    expect(
      contentBox({
        intrinsicWidth: 1000,
        intrinsicHeight: 500,
        rect: { left: 0, top: 0, width: 1000, height: 1000 },
      }),
    ).toEqual({ left: 0, top: 250, width: 1000, height: 500 });
  });

  it('shrinks width and centers horizontally when pillarboxed', () => {
    // 500x1000 (1:2) in a 1000x1000 box → 500x1000 content, 250px left/right.
    expect(
      contentBox({
        intrinsicWidth: 500,
        intrinsicHeight: 1000,
        rect: { left: 0, top: 0, width: 1000, height: 1000 },
      }),
    ).toEqual({ left: 250, top: 0, width: 500, height: 1000 });
  });

  it('returns null for degenerate geometry', () => {
    expect(
      contentBox({
        intrinsicWidth: 0,
        intrinsicHeight: 0,
        rect: { left: 0, top: 0, width: 0, height: 0 },
      }),
    ).toBeNull();
  });
});
