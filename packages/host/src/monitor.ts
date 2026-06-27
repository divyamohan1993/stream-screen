/**
 * monitor — pure helpers for multi-monitor enumeration and coordinate geometry.
 *
 * The host advertises its displays to the viewer as {@link MonitorInfo} so the
 * viewer can present a picker and request a runtime switch. The mapping from
 * Electron's `desktopCapturer` screen sources to physical {@link DisplayGeometry}
 * (bounds + scale factor) is the load-bearing logic for two features:
 *
 *   1. building the `{t:'monitors'}` control message, and
 *   2. translating normalized remote-pointer coordinates into the correct
 *      VIRTUAL-DESKTOP pixel coordinates for the *shared* display — which fixes
 *      the multi-monitor / HiDPI click-misaim bug (a secondary or scaled
 *      monitor must not map 0.5,0.5 to the centre of the PRIMARY display).
 *
 * Everything here is DOM/Electron-free so it unit-tests on Linux. The Electron
 * `screen.getAllDisplays()` / `desktopCapturer` objects are reduced to the small
 * plain shapes below at the call site (main process) and passed in.
 */

import type { MonitorInfo } from '@stream-screen/core';

/** The subset of an Electron `Display` we depend on. */
export interface DisplayGeometry {
  /** Electron display id (number). `display_id` from desktopCapturer is its string form. */
  id: number;
  /** Logical (DIP) bounds in the virtual-desktop coordinate space. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Per-display DPI scale factor (e.g. 1.5 for 150% Windows scaling). */
  scaleFactor: number;
  /**
   * The display's TRUE top-left in virtual-desktop PHYSICAL pixels, as reported
   * by Electron's `screen.dipToScreenPoint(bounds)`. This is the cumulative
   * physical origin across all displays and is the ONLY correct way to place a
   * display on a mixed-DPI virtual desktop. Multiplying the DIP origin
   * (`bounds.x`) by this display's own `scaleFactor` is WRONG whenever an
   * earlier display has a different scale — e.g. a 100% 1920px primary plus a
   * 150% secondary at DIP x=1920 has physical origin x=1920, NOT 1920*1.5=2880.
   *
   * Optional for backward compatibility: when absent, the mapping falls back to
   * `bounds.{x,y} * scaleFactor`, which is exact for the all-100% single-display
   * (and any uniform-scale) case the host historically supported.
   */
  physicalOrigin?: { x: number; y: number };
}

/** The subset of an Electron `desktopCapturer` screen source we depend on. */
export interface RawScreenSource {
  id: string;
  name: string;
  /** Numeric Electron display id as a string; links the source to a Display. */
  display_id?: string;
}

/**
 * Build the {@link MonitorInfo} list advertised to the viewer from the
 * `desktopCapturer` screen sources and the matching {@link DisplayGeometry}.
 *
 * The reported width/height are PHYSICAL pixels (bounds * scaleFactor) so the
 * viewer sees the true captured resolution. The primary display is whichever
 * geometry has bounds origin (0,0) — Electron always anchors the primary there.
 * Sources without a matching display (or without a display_id) fall back to the
 * source name with a 0×0 size so they still appear and can be switched to.
 */
export function buildMonitorList(
  sources: RawScreenSource[],
  displays: DisplayGeometry[],
): MonitorInfo[] {
  const byId = new Map<string, DisplayGeometry>();
  for (const d of displays) byId.set(String(d.id), d);
  return sources.map((s) => {
    const d = s.display_id !== undefined ? byId.get(s.display_id) : undefined;
    const primary = d ? isPrimaryGeometry(d) : false;
    const width = d ? Math.round(d.bounds.width * d.scaleFactor) : 0;
    const height = d ? Math.round(d.bounds.height * d.scaleFactor) : 0;
    return { id: s.id, name: s.name, primary, width, height };
  });
}

/** A display is primary when its logical bounds are anchored at the origin. */
export function isPrimaryGeometry(d: DisplayGeometry): boolean {
  return d.bounds.x === 0 && d.bounds.y === 0;
}

/**
 * Resolve the {@link DisplayGeometry} that a chosen capture source maps to.
 * Returns `null` when the source is a window (no `display_id`) or no display
 * matches — the caller then falls back to primary-display coordinates.
 */
export function geometryForSource(
  source: RawScreenSource,
  displays: DisplayGeometry[],
): DisplayGeometry | null {
  if (source.display_id === undefined) return null;
  return displays.find((d) => String(d.id) === source.display_id) ?? null;
}

/** An absolute point in virtual-desktop PHYSICAL pixels. */
export interface VirtualPoint {
  x: number;
  y: number;
}

/**
 * A display fully expressed in virtual-desktop PHYSICAL pixels: its true origin
 * and its physical width/height. This is the canonical input to the coordinate
 * math — no DIP/scale ambiguity remains once a display is reduced to this shape.
 */
export interface PhysicalDisplayRect {
  /** True top-left in virtual-desktop physical pixels (cumulative across displays). */
  originX: number;
  originY: number;
  /** Physical pixel extent of the display. */
  width: number;
  height: number;
}

/**
 * Reduce a {@link DisplayGeometry} to its {@link PhysicalDisplayRect}.
 *
 * The physical EXTENT is always `bounds.{width,height} * scaleFactor` (a
 * per-display quantity, so this is correct). The physical ORIGIN is taken from
 * `physicalOrigin` when present (Electron `screen.dipToScreenPoint(bounds)` —
 * the only value correct across mixed-DPI layouts). When absent we fall back to
 * `bounds.{x,y} * scaleFactor`, which is exact for uniform-scale layouts (and
 * the historical all-100% single-display case) but WRONG once an earlier
 * display has a different scale.
 */
export function toPhysicalRect(geom: DisplayGeometry): PhysicalDisplayRect {
  const width = geom.bounds.width * geom.scaleFactor;
  const height = geom.bounds.height * geom.scaleFactor;
  const originX = geom.physicalOrigin
    ? geom.physicalOrigin.x
    : geom.bounds.x * geom.scaleFactor;
  const originY = geom.physicalOrigin
    ? geom.physicalOrigin.y
    : geom.bounds.y * geom.scaleFactor;
  return { originX, originY, width, height };
}

/**
 * PURE coordinate math: map a normalized (0..1) pointer coord — relative to the
 * captured frame of ONE display — into an absolute virtual-desktop PHYSICAL
 * pixel point, given that display's {@link PhysicalDisplayRect}.
 *
 * nut.js moves the cursor in the virtual desktop's physical-pixel space (origin
 * at the primary display's top-left), so we scale the normalized coord across
 * the display's physical extent and offset by its true physical origin. Keeping
 * this free of DIP/scale lets it be exhaustively unit-tested with synthetic
 * mixed-DPI layouts.
 *
 * Inputs are clamped to [0,1]; the result is rounded to whole pixels.
 */
export function normalizedToPhysicalPoint(
  x: number,
  y: number,
  rect: PhysicalDisplayRect,
): VirtualPoint {
  const nx = clamp01(x);
  const ny = clamp01(y);
  const localX = Math.min(rect.width - 1, Math.max(0, Math.round(nx * (rect.width - 1))));
  const localY = Math.min(rect.height - 1, Math.max(0, Math.round(ny * (rect.height - 1))));
  return { x: Math.round(rect.originX + localX), y: Math.round(rect.originY + localY) };
}

/**
 * Translate a normalized (0..1) pointer coordinate — relative to the captured
 * frame of ONE display — into an absolute virtual-desktop PHYSICAL pixel point.
 *
 * This is the multi-monitor / HiDPI fix. It reduces the display to its true
 * physical rect (see {@link toPhysicalRect}) and applies the pure
 * {@link normalizedToPhysicalPoint} math. Crucially the offset uses the
 * display's REAL physical origin (`physicalOrigin` from
 * `screen.dipToScreenPoint`), NOT `bounds.x * scaleFactor` — so a 150% secondary
 * adjacent to a 100% primary maps its left edge to the correct cumulative
 * physical edge (1920) rather than 2880.
 *
 * For the primary display (origin 0,0, scale 1) this reduces to the previous
 * behaviour. For a secondary or 150%-scaled monitor it lands the cursor on the
 * display the viewer is actually watching.
 *
 * Inputs are clamped to [0,1]; the result is rounded to whole pixels.
 */
export function normalizedToVirtualPixels(
  x: number,
  y: number,
  geom: DisplayGeometry,
): VirtualPoint {
  return normalizedToPhysicalPoint(x, y, toPhysicalRect(geom));
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
