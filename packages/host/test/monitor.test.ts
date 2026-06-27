/**
 * Unit tests for the pure multi-monitor geometry helpers. These cover both the
 * MonitorInfo advertisement and the coordinate-translation fix for the
 * multi-monitor / HiDPI click-misaim bug — all without Electron.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMonitorList,
  geometryForSource,
  isPrimaryGeometry,
  normalizedToVirtualPixels,
  type DisplayGeometry,
  type RawScreenSource,
} from '../src/monitor.js';

const primary: DisplayGeometry = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};
// Secondary monitor to the right, scaled 150% (HiDPI). Logical 1280x800.
const secondaryHiDPI: DisplayGeometry = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 1280, height: 800 },
  scaleFactor: 1.5,
};

const sources: RawScreenSource[] = [
  { id: 'screen:1:0', name: 'Primary', display_id: '1' },
  { id: 'screen:2:0', name: 'Secondary', display_id: '2' },
];

describe('buildMonitorList', () => {
  it('maps sources to MonitorInfo with physical sizes and primary flag', () => {
    const list = buildMonitorList(sources, [primary, secondaryHiDPI]);
    expect(list).toEqual([
      { id: 'screen:1:0', name: 'Primary', primary: true, width: 1920, height: 1080 },
      // 1280*1.5 = 1920, 800*1.5 = 1200 physical pixels.
      { id: 'screen:2:0', name: 'Secondary', primary: false, width: 1920, height: 1200 },
    ]);
  });

  it('handles sources without a matching display (e.g. unknown id)', () => {
    const list = buildMonitorList([{ id: 'screen:9:0', name: 'Ghost', display_id: '9' }], [primary]);
    expect(list[0]).toEqual({ id: 'screen:9:0', name: 'Ghost', primary: false, width: 0, height: 0 });
  });

  it('handles sources with no display_id', () => {
    const list = buildMonitorList([{ id: 'screen:x', name: 'NoId' }], [primary]);
    expect(list[0].width).toBe(0);
    expect(list[0].primary).toBe(false);
  });
});

describe('isPrimaryGeometry', () => {
  it('treats the origin-anchored display as primary', () => {
    expect(isPrimaryGeometry(primary)).toBe(true);
    expect(isPrimaryGeometry(secondaryHiDPI)).toBe(false);
  });
});

describe('geometryForSource', () => {
  it('resolves the display behind a screen source', () => {
    expect(geometryForSource(sources[1], [primary, secondaryHiDPI])).toBe(secondaryHiDPI);
  });

  it('returns null for a windowed source (no display_id)', () => {
    expect(geometryForSource({ id: 'window:5', name: 'App' }, [primary])).toBeNull();
  });

  it('returns null when no display matches', () => {
    expect(geometryForSource({ id: 's', name: 's', display_id: '99' }, [primary])).toBeNull();
  });
});

describe('normalizedToVirtualPixels', () => {
  it('maps the primary display like a plain pixel mapping', () => {
    expect(normalizedToVirtualPixels(0, 0, primary)).toEqual({ x: 0, y: 0 });
    expect(normalizedToVirtualPixels(1, 1, primary)).toEqual({ x: 1919, y: 1079 });
    expect(normalizedToVirtualPixels(0.5, 0.5, primary)).toEqual({ x: 960, y: 540 });
  });

  it('offsets coords onto a secondary display (the misaim fix)', () => {
    // Centre of the secondary (physical 1920x1200) anchored at x=1920*1.5=2880.
    const p = normalizedToVirtualPixels(0.5, 0.5, secondaryHiDPI);
    // origin x = 1920 * 1.5 = 2880; local centre = round(0.5*(1920-1)) = 960.
    expect(p.x).toBe(2880 + 960);
    expect(p.y).toBe(0 + Math.round(0.5 * (1200 - 1)));
  });

  it('maps the secondary top-left to its physical origin', () => {
    expect(normalizedToVirtualPixels(0, 0, secondaryHiDPI)).toEqual({ x: 2880, y: 0 });
  });

  it('clamps out-of-range normalized values', () => {
    expect(normalizedToVirtualPixels(-1, 2, primary)).toEqual({ x: 0, y: 1079 });
  });
});
