/**
 * renderer — the host control window's renderer script.
 *
 * Pulls boot config and capturable sources over the preload bridge, lets the
 * user pick a screen, and runs a {@link HostSession} (capture + WebRTC + the
 * adaptive auto-negotiate-lag loop). Remote input events are forwarded back to
 * the main process for OS-level injection.
 */

import { HostSession, type HostSessionOptions } from '../host-session.js';
import { normalizeSources, pickDefaultSource, type CaptureSource } from '../capture.js';
import { shouldStopOnLifecycle, type LifecycleReason } from '../window-lifecycle.js';
import type { StreamScreenHostApi } from '../preload.js';
import type { FileMeta } from '@stream-screen/core';

declare global {
  interface Window {
    streamscreen: StreamScreenHostApi;
  }
}

/** The boot config fields the controller needs to spin up / switch a session. */
export interface SessionConfig {
  signalingUrl: string;
  code: string;
  hostName: string;
}

/** A factory for {@link HostSession} (overridable in tests). */
export type HostSessionFactory = (opts: HostSessionOptions) => HostSession;

const defaultHostSessionFactory: HostSessionFactory = (opts) => new HostSession(opts);

/**
 * Owns the single live {@link HostSession} for the host control window and the
 * logic for starting it and changing its capture source.
 *
 * Pulled out of module scope (and away from direct DOM access) so the
 * source-switch behavior is unit-testable without Electron or a DOM: tests
 * construct a controller with a fake preload `api` and a fake session factory.
 */
export class SessionController {
  private session: HostSession | null = null;

  constructor(
    private readonly api: StreamScreenHostApi,
    private readonly onStatusText: (text: string) => void = () => {},
    private readonly makeSession: HostSessionFactory = defaultHostSessionFactory,
  ) {}

  /** The current live session, or null. Exposed for assertions/teardown. */
  get current(): HostSession | null {
    return this.session;
  }

  /**
   * Handle the operator picking a different capture source from the dropdown.
   *
   * CRITICAL: when a session is already live we switch the capture source IN
   * PLACE on the existing {@link HostSession} (re-capture + replaceVideoTrack)
   * rather than stopping and re-creating one with the same code. The old code
   * did `session?.stop()` then immediately `new HostSession(...).start()`, but
   * `stop()` only calls `WebSocket.close()` and returns BEFORE the signaling
   * server has processed the host's departure — so the fresh join could race
   * ahead of the server-observed leave and be REJECTED as `host-exists`
   * (duplicate host codes are now rejected). The handler also ignored the
   * returned promise, so a rejected re-join left the operator with NO advertised
   * session after a source change. Switching in place keeps the room/code/socket
   * joined and advertised the whole time, so the `host-exists` race cannot
   * happen at all. There is no session time limit or usage cap anywhere here.
   *
   * If there is no live session yet (e.g. the very first selection, or after a
   * prior failure left `session` null), we fall back to a full
   * {@link startSession}. Both paths return the promise so the caller does not
   * silently swallow a rejected join.
   */
  async changeSource(cfg: SessionConfig, sourceId: string): Promise<void> {
    const current = this.session;
    if (current) {
      // In-place: no signaling leave/rejoin, so no host-exists race.
      await current.switchSource(sourceId);
      // Keep the main process's active-display mapping in sync. HostSession also
      // fires onActiveDisplay, but call here too in case the source was already
      // active and switchSource short-circuited.
      this.api.setActiveDisplay(sourceId);
      return;
    }
    // No live session — do a full start (and don't swallow its rejection).
    await this.startSession(cfg, sourceId);
  }

  /**
   * Start a fresh session for `sourceId`, tearing down any previous one first.
   * Used for the very first capture and when no session is currently live.
   */
  async startSession(cfg: SessionConfig, sourceId: string): Promise<void> {
    this.session?.stop();
    // Inform the main process which display is shared so remote clicks land on
    // the right monitor (multi-monitor / HiDPI coordinate mapping).
    this.api.setActiveDisplay(sourceId);
    const session = this.makeSession({
      signalingUrl: cfg.signalingUrl,
      code: cfg.code,
      hostName: cfg.hostName,
      sourceId,
      getMonitors: () => this.api.getMonitors(),
      onActiveDisplay: (id) => this.api.setActiveDisplay(id),
      onFileReceived: (data, meta: FileMeta) => {
        void this.api.saveFile({ name: meta.name, mime: meta.mime, data });
      },
      onChat: (text) => {
        this.onStatusText(`Chat from viewer: ${text}`);
      },
      onInput: (e) => this.api.injectInput(e),
      // Route the Ctrl+Alt+Del chord (detected in HostSession) through the combo
      // path so the main process can invoke the real Windows SAS API (SendSAS)
      // instead of replaying synthetic key presses the secure desktop ignores.
      onCombo: (events) => this.api.injectCombo(events),
      onState: (state) => {
        this.api.reportStatus(state);
        this.onStatusText(`Connection: ${state}`);
      },
      onDecision: (d, s) => {
        this.onStatusText(
          [
            `Connection: live`,
            `RTT ${s.rttMs.toFixed(0)} ms · loss ${s.lossPct.toFixed(1)}% · jitter ${s.jitterMs.toFixed(0)} ms`,
            `${s.width}x${s.height} @ ${s.fps.toFixed(0)} fps`,
            `Target ${(d.targetKbps / 1000).toFixed(1)} Mbps · ${d.maxFramerate} fps · scale ÷${d.scaleResolutionDownBy}`,
            `Reason: ${d.reason}`,
          ].join('\n'),
        );
        this.api.reportStatus(`${(d.targetKbps / 1000).toFixed(1)}Mbps`);
      },
    });
    // Only treat the session as the live `current` AFTER start() resolves. If
    // start() rejects (signaling down, host-exists / code already held, or
    // capture failed), HostSession.start() stops itself and rethrows; we must
    // NOT leave `current` pointing at that stopped, peerless session. Otherwise
    // a later changeSource would take the `current` branch and call
    // switchSource() on a dead session (no peer to replaceVideoTrack on) instead
    // of doing a fresh join — and the operator could never recover by selecting
    // a source. Clear `current` and discard the stopped session on failure so a
    // subsequent changeSource performs a full startSession (fresh join). No
    // session time limit or usage cap is introduced here.
    try {
      await session.start();
    } catch (err) {
      // start() already stopped itself on failure; ensure it is fully torn down
      // and drop our reference so the next changeSource starts fresh.
      session.stop();
      this.session = null;
      throw err;
    }
    this.session = session;
  }

  /** Tear down the live session, if any. */
  stop(): void {
    this.session?.stop();
  }

  /**
   * React to a renderer/window lifecycle event WITHOUT over-tearing-down the
   * session.
   *
   * In the Windows tray flow, clicking the control window's close button no
   * longer destroys the renderer — the main process intercepts 'close' and HIDES
   * the window to the tray (see main.ts `decideWindowClose`), keeping the host
   * session joined and the code advertised. A mere HIDE must therefore NOT stop
   * the session; only a real teardown ('unload', fired when the window is
   * genuinely being destroyed on quit) tears the WebRTC/signaling session down.
   *
   * Delegates the decision to the pure {@link shouldStopOnLifecycle} so the
   * keep-alive-on-hide behavior is unit-testable without an Electron window.
   */
  onLifecycle(reason: LifecycleReason): void {
    if (shouldStopOnLifecycle(reason)) this.stop();
  }
}

/**
 * Wire the {@link SessionController} to the real DOM and preload bridge. Runs
 * only in the actual renderer (where `window`/`document` exist); guarded so the
 * module can be imported in a node test without crashing on missing globals.
 */
async function boot(): Promise<void> {
  const api = window.streamscreen;
  const $code = document.getElementById('code') as HTMLDivElement;
  const $source = document.getElementById('source') as HTMLSelectElement;
  const $stats = document.getElementById('stats') as HTMLDivElement;

  const controller = new SessionController(api, (text) => {
    $stats.textContent = text;
  });

  const cfg = await api.getBootConfig();
  $code.textContent = cfg.code;

  const raw = await api.getSources();
  const sources: CaptureSource[] = normalizeSources(raw);
  $source.innerHTML = '';
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    $source.appendChild(opt);
  }
  const def = pickDefaultSource(sources);
  if (def) $source.value = def.id;

  const sessionCfg: SessionConfig = {
    signalingUrl: cfg.signalingUrl,
    code: cfg.code,
    hostName: cfg.hostName,
  };

  $source.addEventListener('change', () => {
    void controller.changeSource(sessionCfg, $source.value).catch((err) => {
      $stats.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    });
  });

  // beforeunload fires ONLY when the renderer is actually being destroyed — i.e.
  // a real app quit, since the main process now intercepts the window 'close'
  // button and HIDES to the tray instead of destroying (see main.ts
  // decideWindowClose). So this is a genuine 'unload' teardown, and onLifecycle
  // stops the session. A mere hide never reaches here, so the host session stays
  // joined and the code stays advertised while the window is hidden in the tray.
  window.addEventListener('beforeunload', () => controller.onLifecycle('unload'));

  if (def) await controller.startSession(sessionCfg, def.id);
}

// Only bootstrap against a real renderer DOM. In a node/unit-test import there
// is no `window`/`document`, so we skip the side effects and just export the
// testable SessionController above.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void boot().catch((err) => {
    const $stats = document.getElementById('stats');
    if ($stats) $stats.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  });
}
