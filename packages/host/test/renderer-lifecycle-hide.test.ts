/**
 * Regression test for FINDING B (P2), renderer half: the SessionController must
 * NOT tear down the live host session on a mere HIDE (close-to-tray) — only on a
 * real UNLOAD (true app quit / renderer destruction).
 *
 * Before the fix the renderer wired `window.beforeunload -> controller.stop()`,
 * and the window's close button DESTROYED the renderer, so closing the window
 * always killed the WebRTC/signaling session even though the app + tray kept
 * running advertising the code. Now the main process hides the window to the tray
 * on close (so beforeunload never fires on a hide), and the renderer routes
 * lifecycle through onLifecycle, which only stops on 'unload'.
 *
 * No Electron / native deps: the HostSession is faked via an injected factory.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionController, type SessionConfig } from '../src/renderer/renderer.js';
import type { HostSession, HostSessionOptions } from '../src/host-session.js';

class FakeHostSession {
  startCalls = 0;
  stopCalls = 0;
  constructor(public readonly opts: HostSessionOptions) {}
  async start(): Promise<void> {
    this.startCalls += 1;
  }
  async switchSource(): Promise<void> {}
  stop(): void {
    this.stopCalls += 1;
  }
}

function makeApi(): {
  setActiveDisplay: ReturnType<typeof vi.fn>;
  injectInput: ReturnType<typeof vi.fn>;
  injectCombo: ReturnType<typeof vi.fn>;
  reportStatus: ReturnType<typeof vi.fn>;
  getMonitors: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
} {
  return {
    setActiveDisplay: vi.fn(),
    injectInput: vi.fn(),
    injectCombo: vi.fn(),
    reportStatus: vi.fn(),
    getMonitors: vi.fn(async () => []),
    saveFile: vi.fn(async () => ({ path: null })),
  };
}

const cfg: SessionConfig = {
  signalingUrl: 'ws://test',
  code: '123456',
  hostName: 'test-host',
};

describe('SessionController.onLifecycle (FINDING B keep-alive-on-hide)', () => {
  it('does NOT stop the session on a hide (close-to-tray): session stays live/advertised', async () => {
    const api = makeApi();
    const built: FakeHostSession[] = [];
    const factory = (opts: HostSessionOptions): HostSession => {
      const s = new FakeHostSession(opts);
      built.push(s);
      return s as unknown as HostSession;
    };
    const controller = new SessionController(
      api as never,
      () => {},
      factory,
    );

    await controller.startSession(cfg, 'screen:0');
    expect(built).toHaveLength(1);
    expect(built[0].startCalls).toBe(1);

    // A mere hide must NOT tear the session down.
    controller.onLifecycle('hide');
    expect(built[0].stopCalls).toBe(0);
    expect(controller.current).toBe(built[0] as unknown as HostSession);
  });

  it('stops the session on a real unload (true quit / renderer destruction)', async () => {
    const api = makeApi();
    const built: FakeHostSession[] = [];
    const factory = (opts: HostSessionOptions): HostSession => {
      const s = new FakeHostSession(opts);
      built.push(s);
      return s as unknown as HostSession;
    };
    const controller = new SessionController(
      api as never,
      () => {},
      factory,
    );

    await controller.startSession(cfg, 'screen:0');

    controller.onLifecycle('unload');
    expect(built[0].stopCalls).toBe(1);
  });
});
