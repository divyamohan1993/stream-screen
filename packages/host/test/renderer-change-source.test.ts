/**
 * Regression test for the host source-switch host-exists race (P2).
 *
 * FINDING — renderer "change source / switch monitor" handler used to call
 * `session.stop()` and IMMEDIATELY construct + `start()` a brand-new
 * HostSession with the SAME session code. `stop()` only calls
 * `WebSocket.close()` and returns BEFORE the signaling server has processed the
 * host's departure, so the fresh join could race ahead of the server-observed
 * leave and be REJECTED as `host-exists` (duplicate host codes are rejected).
 * The handler also ignored the returned promise, so a rejected re-join left the
 * operator with NO advertised session after a source change.
 *
 * FIX — switch the capture SOURCE on the EXISTING HostSession IN PLACE (reusing
 * the monitor-switch `replaceVideoTrack` mechanism) without leaving/rejoining
 * signaling. So a source change must:
 *   - NOT stop the existing session,
 *   - NOT construct a second HostSession (no second join => no host-exists),
 *   - keep the SAME live session advertised, and
 *   - attach the NEW source's video track via the in-place switch.
 *
 * These assertions fail before the fix (which built a new session and joined
 * again) and pass after. No Electron / native deps: the HostSession is faked via
 * an injected factory and the preload `api` is a set of spies.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionController, type SessionConfig } from '../src/renderer/renderer.js';
import type { HostSession, HostSessionOptions } from '../src/host-session.js';

/** A minimal fake HostSession that records lifecycle + source switches. */
class FakeHostSession {
  startCalls = 0;
  stopCalls = 0;
  switchSourceCalls: string[] = [];
  attachedSourceId: string;
  /** Simulates whether this session is still "advertised" (joined & not stopped). */
  advertised = false;

  constructor(public readonly opts: HostSessionOptions) {
    this.attachedSourceId = opts.sourceId;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.advertised = true;
  }

  async switchSource(sourceId: string): Promise<void> {
    this.switchSourceCalls.push(sourceId);
    // In-place switch: the room/code/socket stay joined and advertised, and the
    // new source's video track becomes the attached one.
    this.attachedSourceId = sourceId;
  }

  stop(): void {
    this.stopCalls += 1;
    this.advertised = false;
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

describe('SessionController source switch (P2 host-exists race regression)', () => {
  it('switches the EXISTING session in place — no second join, stays advertised, new track attached', async () => {
    const api = makeApi();
    const built: FakeHostSession[] = [];
    const factory = (opts: HostSessionOptions): HostSession => {
      const s = new FakeHostSession(opts);
      built.push(s);
      return s as unknown as HostSession;
    };

    const controller = new SessionController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api as any,
      () => {},
      factory,
    );

    // First selection: a full start (exactly one HostSession constructed + joined).
    await controller.startSession(cfg, 'screen:0');
    expect(built).toHaveLength(1);
    expect(built[0].startCalls).toBe(1);
    expect(built[0].advertised).toBe(true);

    // Operator changes the capture source.
    await controller.changeSource(cfg, 'screen:1');

    // CRUX: NO second HostSession was constructed => no second signaling join =>
    // the host-exists race cannot happen.
    expect(built).toHaveLength(1);

    // The original session was NOT stopped (room/code/socket stayed joined).
    expect(built[0].stopCalls).toBe(0);
    expect(built[0].advertised).toBe(true);

    // The switch happened IN PLACE and the new source's track is attached.
    expect(built[0].switchSourceCalls).toEqual(['screen:1']);
    expect(built[0].attachedSourceId).toBe('screen:1');

    // The same live session is still the controller's current session.
    expect(controller.current).toBe(built[0] as unknown as HostSession);

    // Active-display mapping kept in sync for the new source.
    expect(api.setActiveDisplay).toHaveBeenCalledWith('screen:1');
  });

  it('does not swallow a rejected switch — the returned promise rejects', async () => {
    const api = makeApi();
    const factory = (opts: HostSessionOptions): HostSession => {
      const s = new FakeHostSession(opts);
      s.switchSource = vi.fn(async () => {
        throw new Error('boom');
      });
      return s as unknown as HostSession;
    };
    const controller = new SessionController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api as any,
      () => {},
      factory,
    );

    await controller.startSession(cfg, 'screen:0');
    await expect(controller.changeSource(cfg, 'screen:1')).rejects.toThrow('boom');
  });

  it('falls back to a full start when there is no live session yet', async () => {
    const api = makeApi();
    const built: FakeHostSession[] = [];
    const factory = (opts: HostSessionOptions): HostSession => {
      const s = new FakeHostSession(opts);
      built.push(s);
      return s as unknown as HostSession;
    };
    const controller = new SessionController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api as any,
      () => {},
      factory,
    );

    // No prior session: changeSource should start one.
    await controller.changeSource(cfg, 'screen:0');
    expect(built).toHaveLength(1);
    expect(built[0].startCalls).toBe(1);
    expect(built[0].switchSourceCalls).toEqual([]);
  });
});
