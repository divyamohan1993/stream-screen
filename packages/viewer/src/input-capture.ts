import type { InputEvent } from '@stream-screen/core';

/**
 * Modifier bitflags matching the protocol contract (`InputEvent` `mods`):
 * 1 = shift, 2 = ctrl, 4 = alt, 8 = meta.
 */
export const MOD_SHIFT = 1;
export const MOD_CTRL = 2;
export const MOD_ALT = 4;
export const MOD_META = 8;

/** A keyboard event's relevant modifier state. */
export interface ModifierState {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Pack a keyboard/mouse event's modifier state into the protocol bitflag set.
 *
 * @example modsFrom({ shiftKey: true, ctrlKey: true, altKey: false, metaKey: false }) === 3
 */
export function modsFrom(e: ModifierState): number {
  let mods = 0;
  if (e.shiftKey) mods |= MOD_SHIFT;
  if (e.ctrlKey) mods |= MOD_CTRL;
  if (e.altKey) mods |= MOD_ALT;
  if (e.metaKey) mods |= MOD_META;
  return mods;
}

/**
 * Map a DOM `MouseEvent.button` (0 left, 1 middle, 2 right, plus back/forward)
 * onto the protocol's 0|1|2 button space. Buttons we don't model collapse to
 * left-click so an unexpected device button never produces an invalid event.
 */
export function mapButton(domButton: number): 0 | 1 | 2 {
  switch (domButton) {
    case 0:
      return 0; // primary / left
    case 1:
      return 1; // auxiliary / middle
    case 2:
      return 2; // secondary / right
    default:
      return 0;
  }
}

/**
 * The intrinsic dimensions and on-screen layout box of the rendered video.
 * `intrinsicWidth`/`intrinsicHeight` are the remote screen's pixel size
 * (`videoWidth`/`videoHeight`); the rect is the element's CSS box.
 */
export interface VideoGeometry {
  intrinsicWidth: number;
  intrinsicHeight: number;
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * Convert a pointer position (client/viewport coordinates) to normalized
 * 0..1 coordinates of the remote screen, accounting for `object-fit: contain`
 * letter-/pillar-boxing so the cursor lands where the user actually points.
 *
 * Points outside the rendered video area are clamped to [0,1]. When geometry
 * is degenerate (zero size) the result is `{0,0}` rather than NaN.
 */
export function normalizePointer(
  clientX: number,
  clientY: number,
  geo: VideoGeometry,
): { x: number; y: number } {
  const { rect, intrinsicWidth, intrinsicHeight } = geo;
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return { x: 0, y: 0 };
  }

  // The video is drawn with object-fit: contain, so it is centered and scaled
  // to fit while preserving aspect ratio. Compute the displayed content box.
  const intrinsicAspect = intrinsicWidth / intrinsicHeight;
  const boxAspect = rect.width / rect.height;

  let contentWidth: number;
  let contentHeight: number;
  if (intrinsicAspect > boxAspect) {
    // Constrained by width → pillarbox top/bottom margins.
    contentWidth = rect.width;
    contentHeight = rect.width / intrinsicAspect;
  } else {
    // Constrained by height → letterbox left/right margins.
    contentHeight = rect.height;
    contentWidth = rect.height * intrinsicAspect;
  }
  const offsetX = rect.left + (rect.width - contentWidth) / 2;
  const offsetY = rect.top + (rect.height - contentHeight) / 2;

  const x = clamp01((clientX - offsetX) / contentWidth);
  const y = clamp01((clientY - offsetY) / contentHeight);
  return { x, y };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Normalize a wheel event's deltas into a device-pixel-ish scroll amount,
 * independent of `deltaMode` (pixel / line / page). Lines are treated as ~16px
 * and pages as the visible content height (or a sane fallback).
 */
export function normalizeWheel(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  pageHeightPx = 800,
): { dx: number; dy: number } {
  let scale = 1;
  if (deltaMode === 1) scale = 16; // DOM_DELTA_LINE
  else if (deltaMode === 2) scale = pageHeightPx; // DOM_DELTA_PAGE
  return { dx: deltaX * scale, dy: deltaY * scale };
}

/** Options for {@link InputCapture}. */
export interface InputCaptureOptions {
  /** The video element rendering the remote screen. */
  video: HTMLVideoElement;
  /** Sink for produced input events (wired to `Peer.sendInput`). */
  send: (e: InputEvent) => void;
  /**
   * Minimum interval between emitted `m-move` events, in ms. Defaults to ~8ms
   * (~120Hz) so pointer movement is smooth without flooding the data channel.
   */
  moveThrottleMs?: number;
  /** Time source (injectable for tests). Defaults to `performance.now`. */
  now?: () => number;
}

const DEFAULT_MOVE_THROTTLE_MS = 1000 / 120;

/**
 * Captures mouse and keyboard interaction on the remote-screen video element
 * and emits resolution-independent {@link InputEvent}s for transport to the
 * host. Coordinates are normalized 0..1 of the remote screen; modifier keys are
 * packed into the protocol bitflags; mouse-move is throttled to ~120Hz.
 *
 * It also supports pointer lock (relative-feeling control) and fullscreen, and
 * mirrors clipboard text both ways via {@link InputEvent} `clipboard` frames.
 *
 * All listeners are attached on {@link attach} and fully removed on
 * {@link detach}; the class keeps no global side effects beyond the element and
 * (optionally) `document` for key/clipboard events while attached.
 */
export class InputCapture {
  private readonly video: HTMLVideoElement;
  private readonly send: (e: InputEvent) => void;
  private readonly moveThrottleMs: number;
  private readonly now: () => number;

  private attached = false;
  private lastMoveAt = Number.NEGATIVE_INFINITY;
  /** Last pointer-lock-accumulated normalized position. */
  private lockX = 0.5;
  private lockY = 0.5;

  private readonly bound: {
    move: (e: MouseEvent) => void;
    down: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
    wheel: (e: WheelEvent) => void;
    context: (e: MouseEvent) => void;
    keydown: (e: KeyboardEvent) => void;
    keyup: (e: KeyboardEvent) => void;
  };

  constructor(opts: InputCaptureOptions) {
    this.video = opts.video;
    this.send = opts.send;
    this.moveThrottleMs = opts.moveThrottleMs ?? DEFAULT_MOVE_THROTTLE_MS;
    this.now = opts.now ?? (() => performance.now());

    this.bound = {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      wheel: (e) => this.onWheel(e),
      context: (e) => e.preventDefault(),
      keydown: (e) => this.onKey(e, 'k-down'),
      keyup: (e) => this.onKey(e, 'k-up'),
    };
  }

  /** Geometry snapshot of the video element for coordinate normalization. */
  private geometry(): VideoGeometry {
    const rect = this.video.getBoundingClientRect();
    return {
      intrinsicWidth: this.video.videoWidth,
      intrinsicHeight: this.video.videoHeight,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }

  /** Whether the document is currently pointer-locked to our video element. */
  private get locked(): boolean {
    return document.pointerLockElement === this.video;
  }

  private onMove(e: MouseEvent): void {
    const t = this.now();
    if (t - this.lastMoveAt < this.moveThrottleMs) return;
    this.lastMoveAt = t;

    let x: number;
    let y: number;
    if (this.locked) {
      // In pointer lock, accumulate relative motion against the intrinsic size.
      const geo = this.geometry();
      const w = geo.intrinsicWidth || 1;
      const h = geo.intrinsicHeight || 1;
      this.lockX = clamp01(this.lockX + e.movementX / w);
      this.lockY = clamp01(this.lockY + e.movementY / h);
      x = this.lockX;
      y = this.lockY;
    } else {
      const p = normalizePointer(e.clientX, e.clientY, this.geometry());
      x = p.x;
      y = p.y;
      this.lockX = x;
      this.lockY = y;
    }
    this.send({ t: 'm-move', x, y });
  }

  private pointerPos(e: MouseEvent): { x: number; y: number } {
    if (this.locked) return { x: this.lockX, y: this.lockY };
    return normalizePointer(e.clientX, e.clientY, this.geometry());
  }

  private onDown(e: MouseEvent): void {
    const { x, y } = this.pointerPos(e);
    this.send({ t: 'm-down', x, y, button: mapButton(e.button) });
  }

  private onUp(e: MouseEvent): void {
    const { x, y } = this.pointerPos(e);
    this.send({ t: 'm-up', x, y, button: mapButton(e.button) });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.pointerPos(e);
    const { dx, dy } = normalizeWheel(
      e.deltaX,
      e.deltaY,
      e.deltaMode,
      this.video.getBoundingClientRect().height || 800,
    );
    this.send({ t: 'm-wheel', x, y, dx, dy });
  }

  private onKey(e: KeyboardEvent, t: 'k-down' | 'k-up'): void {
    // Don't intercept browser-level shortcuts while not focused on the stage.
    e.preventDefault();
    this.send({ t, code: e.code, key: e.key, mods: modsFrom(e) });
  }

  /**
   * Attach all input listeners. Mouse/wheel listen on the video element; key
   * events listen on `document` so keystrokes are captured while the stage has
   * focus. Idempotent.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const v = this.video;
    v.addEventListener('mousemove', this.bound.move);
    v.addEventListener('mousedown', this.bound.down);
    v.addEventListener('mouseup', this.bound.up);
    v.addEventListener('wheel', this.bound.wheel, { passive: false });
    v.addEventListener('contextmenu', this.bound.context);
    document.addEventListener('keydown', this.bound.keydown);
    document.addEventListener('keyup', this.bound.keyup);
  }

  /** Remove all input listeners. Idempotent. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const v = this.video;
    v.removeEventListener('mousemove', this.bound.move);
    v.removeEventListener('mousedown', this.bound.down);
    v.removeEventListener('mouseup', this.bound.up);
    v.removeEventListener('wheel', this.bound.wheel);
    v.removeEventListener('contextmenu', this.bound.context);
    document.removeEventListener('keydown', this.bound.keydown);
    document.removeEventListener('keyup', this.bound.keyup);
  }

  /** Request pointer lock on the video element (best-effort). */
  requestPointerLock(): void {
    void this.video.requestPointerLock?.();
  }

  /** Exit pointer lock if currently held. */
  exitPointerLock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  /** Request fullscreen on the video element (best-effort). */
  async requestFullscreen(): Promise<void> {
    await this.video.requestFullscreen?.();
  }

  /** Exit fullscreen if currently in it. */
  async exitFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen?.();
  }

  /**
   * Read the local clipboard and emit it as a `clipboard` input frame so the
   * host can paste it. Silently no-ops if the Clipboard API is unavailable or
   * permission is denied.
   */
  async syncClipboardToHost(): Promise<void> {
    try {
      const text = await navigator.clipboard?.readText();
      if (typeof text === 'string' && text.length > 0) {
        this.send({ t: 'clipboard', text });
      }
    } catch {
      /* clipboard unavailable / denied — non-fatal */
    }
  }

  /** Write host-originated clipboard text into the local clipboard. */
  async applyClipboardFromHost(text: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable / denied — non-fatal */
    }
  }
}
