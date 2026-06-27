/**
 * Unit tests for the pure capture-constraint builders. These run on Linux with
 * no Electron / getUserMedia — only the constraint-shaping logic is exercised.
 */

import { describe, expect, it } from 'vitest';
import { buildDesktopConstraints } from '../src/capture.js';

describe('buildDesktopConstraints', () => {
  it('produces video-only constraints by default', () => {
    const c = buildDesktopConstraints('screen:0:0');
    expect(c.audio).toBe(false);
    expect(c.video.mandatory.chromeMediaSource).toBe('desktop');
    expect(c.video.mandatory.chromeMediaSourceId).toBe('screen:0:0');
    expect(c.video.mandatory.maxFrameRate).toBe(60);
  });

  it('requests desktop loopback audio when withAudio is true', () => {
    const c = buildDesktopConstraints('screen:1:0', {}, true);
    expect(c.audio).toEqual({ mandatory: { chromeMediaSource: 'desktop' } });
    // Audio constraint must NOT carry a source id — loopback is desktop-wide.
    expect(c.audio === false ? null : c.audio.mandatory).not.toHaveProperty('chromeMediaSourceId');
  });

  it('keeps audio:false when withAudio is explicitly false', () => {
    expect(buildDesktopConstraints('screen:1:0', {}, false).audio).toBe(false);
  });

  it('honors max width/height/framerate caps', () => {
    const c = buildDesktopConstraints('s', { maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 });
    expect(c.video.mandatory.maxWidth).toBe(1280);
    expect(c.video.mandatory.maxHeight).toBe(720);
    expect(c.video.mandatory.maxFrameRate).toBe(30);
  });

  it('omits width/height when not provided', () => {
    const c = buildDesktopConstraints('s');
    expect(c.video.mandatory).not.toHaveProperty('maxWidth');
    expect(c.video.mandatory).not.toHaveProperty('maxHeight');
  });

  it("suppresses the in-frame cursor by default (cursor: 'never')", () => {
    // The viewer renders a low-latency local cursor, so the baked-in cursor is
    // off by default to avoid a second, lagging pointer.
    expect(buildDesktopConstraints('s').video.cursor).toBe('never');
  });

  it("re-enables the in-frame cursor when cursor:true is requested", () => {
    expect(buildDesktopConstraints('s', { cursor: true }).video.cursor).toBe('always');
  });
});
