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
 * Translate a normalized (0..1) pointer coordinate — relative to the captured
 * frame of ONE display — into an absolute virtual-desktop PHYSICAL pixel point.
 *
 * This is the multi-monitor / HiDPI fix. nut.js moves the cursor in the virtual
 * desktop's physical-pixel space (origin at the primary display's top-left), so
 * we must:
 *   1. scale the normalized coord across that display's physical extent
 *      (bounds * scaleFactor), then
 *   2. offset by that display's physical origin (bounds.{x,y} * scaleFactor).
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
  const nx = clamp01(x);
  const ny = clamp01(y);
  const physW = geom.bounds.width * geom.scaleFactor;
  const physH = geom.bounds.height * geom.scaleFactor;
  const originX = geom.bounds.x * geom.scaleFactor;
  const originY = geom.bounds.y * geom.scaleFactor;
  // Map into [0, physW-1] within the display, then offset to virtual space.
  const localX = Math.min(physW - 1, Math.max(0, Math.round(nx * (physW - 1))));
  const localY = Math.min(physH - 1, Math.max(0, Math.round(ny * (physH - 1))));
  return { x: Math.round(originX + localX), y: Math.round(originY + localY) };
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
