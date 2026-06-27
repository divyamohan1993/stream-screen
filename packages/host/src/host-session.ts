/**
 * host-session — the renderer-side orchestrator that ties screen capture,
 * the core WebRTC {@link Peer}, the {@link AdaptiveController}, and remote
 * input forwarding together.
 *
 * Runs in the host's renderer process (where `RTCPeerConnection` and
 * `getUserMedia` exist). Responsibilities:
 *   1. Connect to signaling as role `host` and advertise the session code.
 *   2. Capture the chosen display and attach the stream to the Peer.
 *   3. Run the AUTO-NEGOTIATE-LAG loop: ~1Hz poll of peer.getStats() →
 *      AdaptiveController.update() → peer.applyDecision(). This is the heart of
 *      the "auto-negotiate lag to stay realtime" requirement.
 *   4. Receive InputEvents on the data channel and forward them to the main
 *      process (over the contextBridge IPC) for OS-level injection.
 *
 * There are deliberately NO session timers, usage counters, or bitrate caps in
 * this file. The session runs until the user closes it.
 */

import {
  AdaptiveController,
  Peer,
  SignalingClient,
  type AdaptiveDecision,
  type AdaptiveStats,
  type InputEvent,
} from '@stream-screen/core';
import { getDisplayStream, type CaptureConstraints } from './capture.js';

/** How often the adaptive loop samples stats and re-negotiates (ms). */
export const ADAPTIVE_INTERVAL_MS = 1000;

/** Options for {@link HostSession}. */
export interface HostSessionOptions {
  /** Signaling server URL, e.g. `ws://192.168.1.10:8787`. */
  signalingUrl: string;
  /** The 6–9 digit session code that gates this session. */
  code: string;
  /** Human-friendly host name advertised to viewers. */
  hostName: string;
  /** desktopCapturer source id to share. */
  sourceId: string;
  /** Optional capture quality constraints (defaults: native res, 60fps). */
  capture?: CaptureConstraints;
  /** Optional STUN/TURN servers (LAN-first deployments need none). */
  iceServers?: RTCIceServer[];
  /**
   * Forward a received InputEvent to the main process for injection. In the
   * real app this is `window.streamscreen.injectInput`; tests inject a spy.
   */
  onInput: (e: InputEvent) => void;
  /** Optional observer for each adaptive decision (e.g. to update the UI). */
  onDecision?: (d: AdaptiveDecision, s: AdaptiveStats) => void;
  /** Optional observer for peer connection-state changes. */
  onState?: (state: string) => void;
  /** Test seam: override the stream acquisition. Defaults to {@link getDisplayStream}. */
  acquireStream?: (sourceId: string, c?: CaptureConstraints) => Promise<MediaStream>;
}

/**
 * A live host session. Construct, then `await start()`. Call `stop()` to tear
 * everything down. Re-entrant `start()` calls are ignored.
 */
export class HostSession {
  private readonly opts: HostSessionOptions;
  private readonly controller = new AdaptiveController();
  private signaling: SignalingClient | null = null;
  private peer: Peer | null = null;
  private stream: MediaStream | null = null;
  private adaptiveTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastDecision: AdaptiveDecision | null = null;

  constructor(opts: HostSessionOptions) {
    this.opts = opts;
  }

  /** The most recent adaptive decision, or null before the first tick. */
  get currentDecision(): AdaptiveDecision | null {
    return this.lastDecision;
  }

  /**
   * Connect to signaling, capture the display, attach it to the peer, wire up
   * input forwarding, and start the adaptive loop.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const signaling = new SignalingClient(this.opts.signalingUrl);
    this.signaling = signaling;
    await signaling.connect();

    const peer = new Peer({
      role: 'host',
      signaling,
      iceServers: this.opts.iceServers,
    });
    this.peer = peer;

    peer.onInput((e) => this.opts.onInput(e));
    if (this.opts.onState) {
      peer.on('state', (...args: unknown[]) => {
        this.opts.onState?.(String(args[0]));
      });
    }

    await peer.start();

    // Join the room keyed by the session code, as the host.
    signaling.join({ code: this.opts.code, role: 'host', name: this.opts.hostName });

    // Acquire and attach the capture stream (native res, 60fps target).
    const acquire = this.opts.acquireStream ?? getDisplayStream;
    this.stream = await acquire(this.opts.sourceId, this.opts.capture);
    peer.attachStream(this.stream);

    this.startAdaptiveLoop();
  }

  /**
   * Start the periodic auto-negotiate-lag loop. Exposed-ish via {@link tick}
   * for deterministic testing.
   */
  private startAdaptiveLoop(): void {
    if (this.adaptiveTimer) return;
    this.adaptiveTimer = setInterval(() => {
      void this.tick();
    }, ADAPTIVE_INTERVAL_MS);
  }

  /**
   * One iteration of the adaptive loop: sample stats, compute a decision, apply
   * it to the sender. Safe to call manually in tests. Swallows transient stats
   * errors (e.g. before the connection is up) so the loop never dies.
   */
  async tick(): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    let stats: AdaptiveStats;
    try {
      stats = await peer.getStats();
    } catch {
      return;
    }
    const decision = this.controller.update(stats);
    this.lastDecision = decision;
    try {
      await peer.applyDecision(decision);
    } catch {
      // Sender may not be ready yet; the next tick retries.
    }
    this.opts.onDecision?.(decision, stats);
  }

  /** Tear down the adaptive loop, peer, stream, and signaling. Idempotent. */
  stop(): void {
    if (this.adaptiveTimer) {
      clearInterval(this.adaptiveTimer);
      this.adaptiveTimer = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.signaling = null;
    this.started = false;
  }
}

/**
 * Generate a cryptographically-random session code of the given length
 * (6–9 digits per the security model). Pure given an RNG; defaults to the
 * platform crypto when available, falling back to Math.random.
 */
export function generateSessionCode(
  length = 6,
  rng: () => number = defaultRng,
): string {
  const n = Math.min(9, Math.max(6, Math.trunc(length)));
  let out = '';
  for (let i = 0; i < n; i++) {
    out += Math.floor(rng() * 10).toString();
  }
  return out;
}

function defaultRng(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] / 0x100000000;
  }
  return Math.random();
}
