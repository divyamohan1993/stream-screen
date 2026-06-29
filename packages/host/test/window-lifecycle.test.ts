/**
 * Regression tests for FINDING B (P2): keep the host session alive when closing
 * the control window (close-to-tray pattern).
 *
 * Previously, clicking the control window's close button destroyed the renderer,
 * which fired beforeunload -> controller.stop() and tore down the WebRTC/
 * signaling host session — yet the main process + tray kept running showing a
 * code with NO live host behind it. The fix: the BrowserWindow 'close' event
 * HIDES the window to the tray unless the app is genuinely quitting; the renderer
 * only tears the session down on a real 'unload', never on a mere hide.
 *
 * These tests exercise the pure decision logic (no real Electron binary):
 *   - decideWindowClose: hide when NOT quitting; allow destroy when quitting.
 *   - the simulated BrowserWindow 'close' handler preventDefault()s + hide()s
 *     when not quitting, and destroys (no hide) when isQuitting is set.
 */

import { describe, expect, it } from 'vitest';
import { decideWindowClose, shouldStopOnLifecycle } from '../src/window-lifecycle.js';

describe('decideWindowClose (FINDING B: close hides to tray unless quitting)', () => {
  it('HIDES (prevents destroy) when the app is NOT quitting', () => {
    expect(decideWindowClose(false)).toEqual({ hide: true });
  });

  it('allows destroy (no hide) ONLY when the app IS quitting', () => {
    expect(decideWindowClose(true)).toEqual({ hide: false });
  });
});

describe("BrowserWindow 'close' handler decision (close-to-tray)", () => {
  // A minimal stand-in for the BrowserWindow 'close' event + window, mirroring
  // exactly what main.ts wires:
  //   win.on('close', (event) => {
  //     if (decideWindowClose(isQuitting).hide) { event.preventDefault(); win.hide(); }
  //   });
  function simulateClose(isQuitting: boolean): {
    prevented: boolean;
    hidden: boolean;
    destroyed: boolean;
  } {
    let prevented = false;
    let hidden = false;
    const event = {
      preventDefault(): void {
        prevented = true;
      },
    };
    const win = {
      hide(): void {
        hidden = true;
      },
    };
    // The handler body from main.ts:
    if (decideWindowClose(isQuitting).hide) {
      event.preventDefault();
      win.hide();
    }
    // The window is destroyed iff the close was NOT prevented.
    return { prevented, hidden, destroyed: !prevented };
  }

  it('hides (not destroys) when not quitting: preventDefault + hide, window survives', () => {
    const r = simulateClose(false);
    expect(r.prevented).toBe(true);
    expect(r.hidden).toBe(true);
    expect(r.destroyed).toBe(false);
  });

  it('allows destroy only when isQuitting is set: no preventDefault, no hide', () => {
    const r = simulateClose(true);
    expect(r.prevented).toBe(false);
    expect(r.hidden).toBe(false);
    expect(r.destroyed).toBe(true);
  });
});

describe('shouldStopOnLifecycle (renderer keep-alive-on-hide)', () => {
  it('does NOT stop the session on a mere hide', () => {
    expect(shouldStopOnLifecycle('hide')).toBe(false);
  });

  it('stops the session only on a real unload (true quit/destroy)', () => {
    expect(shouldStopOnLifecycle('unload')).toBe(true);
  });
});
