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
  AUTH_DOMAIN,
  createSender,
  CTRL_ALT_DEL,
  FileTransferManager,
  isIceServerList,
  KEY_MODS,
  NONCE_BYTES,
  Peer,
  randomBytes,
  SignalingClient,
  toBase64,
  type AdaptiveDecision,
  type AdaptiveStats,
  type ControlMessage,
  type FileMeta,
  type FileSender,
  type InputEvent,
  type MonitorInfo,
  type QualityPreset,
  type SignalMessage,
  type VerifierRecord,
} from '@stream-screen/core';
import { getDisplayStream, streamHasAudio, type CaptureConstraints } from './capture.js';
import {
  challengeModeOf,
  modeRequiresPin,
  modeRequiresPrompt,
  type AccessMode,
} from './access-config.js';
import { AuthVerifier } from './auth-verifier.js';
import { ConsentManager, type PeerInfo } from './consent-manager.js';
import { LockoutTracker } from './lockout-tracker.js';

/**
 * Pure detector: is this single inbound {@link InputEvent} the Ctrl+Alt+Del
 * chord's signature — a key-DOWN for Delete with BOTH Ctrl and Alt held?
 *
 * Kept inline (rather than importing the equivalent `isCtrlAltDelCombo` from
 * input-injector) so this renderer-side module never statically pulls in the
 * main-process injector, which imports `node:child_process` and the optional
 * native nut.js types. The renderer bundle (esbuild, platform 'browser') would
 * fail to resolve those Node builtins. Mirrors input-injector's
 * `isCtrlAltDelCombo` for a single event; both accept `Delete`/`NumpadDecimal`.
 */
export function isCtrlAltDelKeyDown(e: InputEvent): boolean {
  if (e.t !== 'k-down') return false;
  if (e.code !== 'Delete' && e.code !== 'NumpadDecimal') return false;
  const mods = e.mods | 0;
  return (mods & KEY_MODS.ctrl) !== 0 && (mods & KEY_MODS.alt) !== 0;
}

/**
 * How often the adaptive loop samples stats and re-negotiates (ms).
 *
 * Sampling at ~2 Hz (every 500ms) — rather than the previous 1 Hz — halves the
 * worst-case reaction time to a congestion event so the engine can defend
 * real-time interactivity faster. Application of decisions is ASYMMETRIC and
 * oscillation-safe (see {@link HostSession.tick} and
 * {@link INCREASE_CONFIRM_TICKS}): DECREASE/HOLD apply immediately every tick;
 * an INCREASE applies only after a sustained clean link.
 */
export const ADAPTIVE_INTERVAL_MS = 500;

/**
 * Number of CONSECUTIVE INCREASE classifications required before the host
 * actually applies one (the "slow-up" half of fast-down / slow-up).
 *
 * At {@link ADAPTIVE_INTERVAL_MS} = 500ms, requiring 4 consecutive clean
 * samples means a ramp-up only commits after ~2s of sustained healthy link,
 * which damps oscillation: a single clean blip never bumps the bitrate, but a
 * genuinely-recovered link still ramps promptly. Backing off, by contrast, is
 * immediate every tick — we always prioritize real-time over quality.
 *
 * This gate is a deterministic COUNTER (not wall-clock), so it is fully
 * unit-testable: N increase decisions in a row commit exactly one increase.
 */
export const INCREASE_CONFIRM_TICKS = 4;

/**
 * The phase a {@link AdaptiveDecision} represents, parsed from the controller's
 * `reason` string (which the engine prefixes with `INCREASE:` / `HOLD:` /
 * `DECREASE:`). The controller is authoritative for the MATH; the host only
 * reads back which phase it chose to gate APPLICATION asymmetrically. Returns
 * null if the reason is not recognized (then we treat it as non-increase).
 */
function decisionPhase(d: AdaptiveDecision): 'INCREASE' | 'HOLD' | 'DECREASE' | null {
  if (d.reason.startsWith('INCREASE')) return 'INCREASE';
  if (d.reason.startsWith('DECREASE')) return 'DECREASE';
  if (d.reason.startsWith('HOLD')) return 'HOLD';
  return null;
}

/**
 * Default time (ms) {@link HostSession.start} waits for the signaling server's
 * `joined` acknowledgement after sending the host `join`, before aborting.
 *
 * This is a CONNECT-TIME HANDSHAKE TIMEOUT ONLY — it bounds the wait for the
 * server to confirm the room is ours. It is emphatically NOT a session duration
 * limit or usage cap: once joined, the session runs until the user closes it.
 */
export const JOIN_ACK_TIMEOUT_MS = 10_000;

/**
 * Thrown when the host's signaling `join` is rejected by the server (e.g. the
 * session code is already held by a live host — `host-exists`) or no `joined`
 * acknowledgement arrives within {@link JOIN_ACK_TIMEOUT_MS}.
 */
export class HostJoinRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostJoinRejectedError';
  }
}

/**
 * Mark a captured video track as screen content so the encoder preserves sharp
 * text instead of optimizing for motion. Best-effort: `contentHint` is a
 * standard MediaStreamTrack property but may be absent on non-browser backends.
 */
function hintScreenContent(track: MediaStreamTrack): void {
  try {
    if ('contentHint' in track) {
      (track as MediaStreamTrack & { contentHint: string }).contentHint = 'text';
    }
  } catch {
    /* backend doesn't support contentHint */
  }
}

/** A file the host wants to push to the viewer. */
export interface OutboundFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

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
   * `viewerId` identifies which viewer sent the event so the host can attribute
   * or arbitrate input from multiple simultaneous controllers.
   */
  onInput: (e: InputEvent, viewerId: string) => void;
  /**
   * Forward a special-key CHORD (an ordered InputEvent list) to the main process
   * for atomic injection via the combo/SAS path. In the app this is
   * `window.streamscreen.injectCombo`; tests inject a spy.
   *
   * This exists so the host can route the Ctrl+Alt+Del chord — which arrives over
   * the ordinary input channel as individual InputEvents — to the real Windows
   * Secure Attention Sequence (SAS) API instead of replaying synthetic key
   * presses, which the kernel ignores for the secure desktop. See the routing in
   * {@link start}. If omitted, the chord falls back to per-event {@link onInput}.
   *
   * NOTE: software-initiated SAS on Windows requires the "SoftwareSASGeneration"
   * group policy to be enabled on the host; otherwise SendSAS no-ops (see
   * input-injector `sendSAS`). Routing is still correct regardless of policy.
   */
  onCombo?: (events: InputEvent[], viewerId: string) => void;
  /** Optional observer for each adaptive decision (e.g. to update the UI). */
  onDecision?: (d: AdaptiveDecision, s: AdaptiveStats) => void;
  /** Optional observer for peer connection-state changes. */
  onState?: (state: string) => void;
  /**
   * Whether to attempt capturing system (loopback) audio alongside video.
   * Defaults to true; falls back to video-only if the platform refuses.
   */
  withAudio?: boolean;
  /**
   * Provide the current monitor list when the viewer requests one
   * (`{t:'request-monitors'}`). In the app this calls the preload bridge; tests
   * inject a stub. If omitted, the host replies with an empty list.
   */
  getMonitors?: () => Promise<MonitorInfo[]> | MonitorInfo[];
  /**
   * Notify the main process which display is now shared (for input-coordinate
   * mapping) after a monitor switch. In the app this is `setActiveDisplay`.
   */
  onActiveDisplay?: (sourceId: string) => void;
  /** Called with an inbound (viewer → host) transferred file once reassembled. */
  onFileReceived?: (data: Uint8Array, meta: FileMeta, viewerId: string) => void;
  /** Called with each inbound chat message from the viewer. */
  onChat?: (text: string, ts: number, viewerId: string) => void;
  /** Called when a viewer connects (joins and negotiates). */
  onViewerJoined?: (viewerId: string) => void;
  /** Called when a viewer disconnects. */
  onViewerLeft?: (viewerId: string) => void;
  /** Test seam: override the stream acquisition. Defaults to {@link getDisplayStream}. */
  acquireStream?: (
    sourceId: string,
    c?: CaptureConstraints,
    withAudio?: boolean,
  ) => Promise<MediaStream>;
  /**
   * Override the connect-time handshake timeout (ms) — how long {@link start}
   * waits for the signaling server's `joined` acknowledgement before aborting.
   * Purely a connect handshake bound; NOT a session time limit. Defaults to
   * {@link JOIN_ACK_TIMEOUT_MS}.
   */
  joinTimeoutMs?: number;
  /**
   * The EFFECTIVE access mode (from access-config). Defaults to 'open', which
   * preserves the historical behavior EXACTLY: media attaches immediately and
   * input flows with no consent prompt and no PIN. In any non-'open' mode a
   * viewer is gated until AUTHORIZED (see the auth flow in {@link start}).
   * 'refuse' refuses ALL viewers (fail-closed for a misconfigured PIN mode).
   */
  accessMode?: AccessMode;
  /**
   * The host's PIN verifier (salt + PBKDF2-derived key). REQUIRED for the 'pin'
   * and 'pin-and-prompt' modes; null/absent otherwise. Never contains the PIN.
   */
  verifier?: VerifierRecord | null;
  /**
   * The {@link ConsentManager} backing the 'prompt' / 'pin-and-prompt' human
   * Accept. Injected so the UI (and tests) can drive accept/reject. If omitted
   * in a prompt mode, a default manager with a 30s fail-closed timeout is used.
   */
  consent?: ConsentManager;
  /**
   * The {@link LockoutTracker} for online brute-force defense. Injected so tests
   * can use a fast clock; defaults to a tracker with the standard thresholds.
   */
  lockout?: LockoutTracker;
  /**
   * Observe authorization lifecycle for a viewer (UI/telemetry). Fired with the
   * final verdict once a viewer is authorized or denied in a non-'open' mode.
   */
  onAuthResult?: (viewerId: string, ok: boolean) => void;
}

/**
 * A live host session. Construct, then `await start()`. Call `stop()` to tear
 * everything down. Re-entrant `start()` calls are ignored.
 */
export class HostSession {
  private readonly opts: HostSessionOptions;
  /**
   * The adaptive controller. NOT readonly: a viewer `{t:'quality',preset}` swaps
   * it for one bounded to the preset's ceiling so the preset actually changes the
   * stream (see {@link applyQualityPreset}). 'auto' restores the full range.
   */
  private controller = new AdaptiveController();
  /** The currently-applied quality preset (defaults to full-range adaptive). */
  private qualityPreset: QualityPreset = 'auto';
  private signaling: SignalingClient | null = null;
  private peer: Peer | null = null;
  private stream: MediaStream | null = null;
  /**
   * The ICE servers (STUN/TURN) the {@link Peer} was constructed with for this
   * session. Resolved at {@link start} time: the server-distributed list on the
   * `joined` ack takes precedence (so host + viewer match), falling back to the
   * local override from {@link HostSessionOptions.iceServers} (env
   * STREAMSCREEN_ICE_SERVERS). Empty by default — LAN-only, behavior unchanged.
   */
  private resolvedIceServers: RTCIceServer[] = [];
  private adaptiveTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastDecision: AdaptiveDecision | null = null;
  /** The desktopCapturer source id currently being shared (tracks switches). */
  private activeSourceId: string;
  /**
   * Reassembles inbound (viewer → host) file transfers, one manager PER viewer
   * so concurrent transfers from different viewers never collide on transfer ids
   * or chunk sequences. Keyed by viewer id; created lazily on first chunk/offer.
   */
  private readonly fileManagers = new Map<string, FileTransferManager>();
  /** A counter that ids outbound (host → viewer) transfers uniquely. */
  private outboundSeq = 0;
  /**
   * Consecutive-INCREASE counter implementing the "slow-up" application gate.
   * Each tick whose controller decision classifies as INCREASE increments it;
   * once it reaches {@link INCREASE_CONFIRM_TICKS} the increase is APPLIED and
   * the counter resets to 0. ANY non-increase decision (HOLD/DECREASE) resets it
   * immediately. Deterministic — no wall-clock involved. See {@link tick}.
   */
  private consecutiveIncreases = 0;
  /**
   * Latest viewer→host end-to-end latency report(s), keyed by viewer id, from
   * the `{t:'latency'}` ControlMessage. Each tick the WORST-CASE (max) reported
   * rttMs/playoutMs across all viewers is folded into the stats handed to the
   * controller, so the host governs on true end-to-end interactive latency, not
   * just its own sender-side measurement. Empty until a viewer reports.
   */
  private readonly viewerLatency = new Map<string, { rttMs: number; playoutMs: number }>();

  // ----- Connection-consent / access-PIN state -----
  /** Effective access mode for this session ('open' = no gating). */
  private readonly accessMode: AccessMode;
  /** Host PIN verifier (PIN modes only); never the plaintext PIN. */
  private readonly verifier: VerifierRecord | null;
  /** Online-brute-force lockout tracker (PIN modes). */
  private readonly lockout: LockoutTracker;
  /** Human-Accept consent core (prompt modes). */
  private readonly consent: ConsentManager;
  /** Verifies viewer proofs against the verifier, gated by the lockout. */
  private readonly authVerifier: AuthVerifier;
  /**
   * Set of viewer ids that are AUTHORIZED (passed the required PIN/consent for
   * the active mode). In 'open' mode every viewer is implicitly authorized and
   * this set is unused. Input from a non-authorized viewer is dropped, and the
   * shared media stream is not attached until the FIRST viewer authorizes.
   */
  private readonly authorizedViewers = new Set<string>();
  /**
   * Per-viewer host nonce (base64-decoded) issued in the auth-challenge, kept
   * until that viewer's auth-response is verified. Binds a proof to the specific
   * challenge so a captured proof cannot be replayed against a fresh nonce.
   */
  private readonly pendingChallenges = new Map<string, Uint8Array>();
  /**
   * Whether the shared media stream has been attached to the peer yet. In
   * 'open' mode we attach session-wide (replay-to-new) exactly once. In
   * non-'open' modes this flag is unused — media is attached PER authorized
   * viewer via {@link Peer.attachStreamTo} (see {@link authorizeViewer}), never
   * session-wide, so an unapproved viewer can never receive the screen.
   */
  private streamAttached = false;
  /**
   * Display names captured at JOIN time, keyed by viewer id. The access
   * handshake is (re)started not from the signaling join (which fires before the
   * viewer's WebRTC control channel exists — auth frames sent then are silently
   * dropped) but from {@link Peer.onControlOpen}, which fires once that viewer's
   * control channel is actually open. The callback only gets the viewer id, so
   * the join-time name is stashed here for the challenge/consent record.
   */
  private readonly viewerNames = new Map<string, string | undefined>();
  /**
   * Disposer for the {@link Peer.onControlOpen} subscription that drives the
   * access handshake; removed on {@link stop}.
   */
  private disposeControlOpen: (() => void) | null = null;

  constructor(opts: HostSessionOptions) {
    this.opts = opts;
    this.activeSourceId = opts.sourceId;
    this.accessMode = opts.accessMode ?? 'open';
    this.verifier = opts.verifier ?? null;
    this.lockout = opts.lockout ?? new LockoutTracker();
    this.consent = opts.consent ?? new ConsentManager();
    this.authVerifier = new AuthVerifier(this.lockout);
  }

  /** The effective access mode in force for this session. */
  get currentAccessMode(): AccessMode {
    return this.accessMode;
  }

  /** The consent manager (so the renderer/main can drive accept/reject). */
  get consentManager(): ConsentManager {
    return this.consent;
  }

  /** True if `viewerId` is currently authorized to receive media + drive input. */
  isAuthorized(viewerId: string): boolean {
    // 'open' mode: every connected viewer is implicitly authorized (legacy).
    if (this.accessMode === 'open') return true;
    return this.authorizedViewers.has(viewerId);
  }

  /** The source id currently being shared. */
  get currentSourceId(): string {
    return this.activeSourceId;
  }

  /**
   * The ICE servers (STUN/TURN) in effect for this session's {@link Peer} —
   * resolved at {@link start} time from the signaling `joined` ack (server
   * distributed, takes precedence) or the local override env. Empty before
   * {@link start} and whenever neither source supplies any (LAN-only default).
   * Returns a defensive copy so callers cannot mutate internal state.
   */
  get currentIceServers(): RTCIceServer[] {
    return this.resolvedIceServers.map((s) => ({ ...s }));
  }

  /** The most recent adaptive decision, or null before the first tick. */
  get currentDecision(): AdaptiveDecision | null {
    return this.lastDecision;
  }

  /** The quality preset currently in effect ('auto' = full-range adaptive). */
  get currentPreset(): QualityPreset {
    return this.qualityPreset;
  }

  /**
   * Re-bound the adaptive controller to a viewer-selected quality preset.
   *
   * Without this, a `{t:'quality',preset}` control message was acknowledged by
   * the protocol but never wired to the encoder — the adaptive loop kept ramping
   * toward the default 40 Mbps ceiling regardless of what the viewer chose.
   *
   * The preset maps to a `maxKbps` CEILING that bounds the AIMD engine: because
   * {@link AdaptiveController.update} clamps every decision to `[minKbps,maxKbps]`,
   * a lower ceiling forces a lower target bitrate (and, via the engine's
   * bitrate-derived framerate/scale, a lighter stream) on subsequent ticks.
   *
   * - 'auto'     → full adaptive range (no artificial ceiling); the unlimited mode.
   * - 'high'     → generous ceiling, still well below auto's max.
   * - 'balanced' → mid ceiling.
   * - 'low'      → tight ceiling for constrained links.
   *
   * This edits NOTHING in @stream-screen/core — it only uses the public
   * {@link AdaptiveController} constructor and its existing bounds. The new
   * controller starts at the engine's conservative baseline and re-ramps within
   * the preset ceiling on subsequent ticks. There is no time limit or usage cap
   * anywhere here.
   */
  applyQualityPreset(preset: QualityPreset): void {
    this.qualityPreset = preset;
    const { minKbps, maxKbps } = qualityBounds(preset);
    this.controller = new AdaptiveController({ minKbps, maxKbps });
  }

  /**
   * Bring the host session up, in this order: capture the display FIRST, then
   * connect to signaling, join the room as the host and AWAIT the server's
   * `joined` acknowledgement, and only after a confirmed join attach the stream
   * to the peer and start the adaptive loop. ANY failure along the way (capture,
   * connect, peer start, a rejected join such as `host-exists`, or a join-ack
   * timeout) fully tears down via {@link stop} so no dangling joined socket or
   * live advertised room is ever left behind. The handshake wait is a
   * connect-time bound only ({@link JOIN_ACK_TIMEOUT_MS}); it is NOT a session
   * time limit. Re-entrant calls are ignored.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      // ACQUIRE the capture stream FIRST — before we ever announce ourselves to
      // signaling. A capture failure (getUserMedia rejects, permission denied,
      // no source) must abort start() WITHOUT having joined a room: otherwise the
      // socket lingers as a live, advertised host with NO media — a dead room
      // viewers can still list and join (data-only, no screen). By acquiring up
      // front, any acquire rejection propagates here and tears down cleanly via
      // the catch below, having never joined. Audio is best-effort:
      // getDisplayStream falls back to video-only if loopback fails.
      const acquire = this.opts.acquireStream ?? getDisplayStream;
      const withAudio = this.opts.withAudio ?? true;
      const stream = await acquire(this.opts.sourceId, this.opts.capture, withAudio);
      this.stream = stream;

      const signaling = new SignalingClient(this.opts.signalingUrl);
      this.signaling = signaling;
      await signaling.connect();

      // Join the room keyed by the session code, as the host, then WAIT for the
      // server's acknowledgement before treating the room as ours. Per the shared
      // signaling contract the server replies `joined` on success or `error`
      // (code/message `host-exists`) when the code is already held by a live host.
      // Without this handshake a rejected join would still proceed to capture and
      // advertise a usable-looking code we do not actually own. A rejection or a
      // handshake timeout throws and is cleaned up by the catch below.
      //
      // The `joined` ack may also carry the operator's server-distributed ICE
      // (STUN/TURN) list — captured here so the host builds its Peer against the
      // SAME config the viewer will (required for symmetric NAT traversal). We
      // join BEFORE constructing the Peer specifically so that list is available
      // to the per-viewer RTCPeerConnections. Viewers cannot have joined yet (we
      // have not acked), so wiring the Peer + signaling viewer handlers after the
      // join loses no events.
      const ackIce = await this.awaitHostJoinAck(signaling, () => {
        signaling.join({ code: this.opts.code, role: 'host', name: this.opts.hostName });
      });

      // Resolve the effective ICE list: server-distributed (ack) wins, else the
      // local override env (opts.iceServers), else [] — LAN-only, unchanged.
      this.resolvedIceServers = this.resolveIceServers(ackIce);

      const peer = new Peer({
        role: 'host',
        signaling,
        iceServers: this.resolvedIceServers,
      });
      this.peer = peer;

      peer.onInput((e, viewerId) => this.routeInput(e, viewerId));
      if (this.opts.onState) {
        peer.on('state', (...args: unknown[]) => {
          this.opts.onState?.(String(args[0]));
        });
      }

      // Reassemble inbound file transfers per viewer; hand finished bytes to the
      // host app tagged with the originating viewer.
      peer.onFileChunk((buf, viewerId) => this.fileManagerFor(viewerId).onChunk(buf));
      peer.onControl((m, viewerId) => void this.handleControl(m, viewerId));

      // Surface viewer connect/disconnect to the host UI. A viewer leaving also
      // drops its per-viewer file manager so a stale partial transfer is not kept.
      signaling.on('peer-joined', (msg) => {
        if (msg.role === 'viewer' && msg.from) {
          this.opts.onViewerJoined?.(msg.from);
          // Stash the join-time name so the access handshake (driven later by
          // onControlOpen, which only carries the viewer id) can use it for the
          // challenge / consent record. We do NOT begin auth here: the signaling
          // join fires BEFORE this viewer's WebRTC control channel exists, and
          // auth frames sent over a not-yet-open control channel are silently
          // dropped — leaving the viewer stuck. Auth (re)starts in onControlOpen.
          this.viewerNames.set(msg.from, msg.name);
        }
      });
      signaling.on('peer-left', (msg) => {
        if (!msg.from) return;
        this.fileManagers.delete(msg.from);
        this.viewerLatency.delete(msg.from);
        this.authorizedViewers.delete(msg.from);
        this.pendingChallenges.delete(msg.from);
        this.viewerNames.delete(msg.from);
        if (msg.role === 'viewer') this.opts.onViewerLeft?.(msg.from);
      });

      await peer.start();

      // ACCESS HANDSHAKE TIMING (P1-A). In any non-'open' mode, begin the access
      // handshake for a viewer the moment ITS control data channel opens — the
      // ONLY point at which sendControl(..., viewerId) is actually delivered.
      // Starting from the signaling join (above) raced ahead of the channel and
      // dropped the initial auth-challenge/auth-result. onControlOpen fires once
      // per connection (and replays already-open channels to a late subscriber),
      // so every gated viewer gets exactly one challenge at the right time. The
      // challenge/consent flows over the encrypted control channel; signaling
      // never carries any secret.
      if (this.accessMode !== 'open') {
        this.disposeControlOpen = peer.onControlOpen((viewerId) => {
          this.beginAuth(viewerId, this.viewerNames.get(viewerId));
        });
      }

      // Tell the encoder this is screen content: optimize for sharp static text
      // over motion smoothness. Without this hint the encoder treats it as camera
      // video and blurs text. Paired with degradationPreference 'maintain-resolution'
      // in Peer.applyDecisionTo, the pipeline drops framerate before resolution.
      for (const t of stream.getVideoTracks()) hintScreenContent(t);

      // ACCESS GATING. In the DEFAULT 'open' mode we attach media immediately —
      // exactly the historical behavior (code-gated only). In any non-'open' mode
      // we DELAY attachStream until a viewer is AUTHORIZED (see ensureStreamAttached,
      // called from the auth flow), so an unauthorized viewer never triggers media
      // negotiation and never sees the screen. 'refuse' never attaches at all.
      if (this.accessMode === 'open') {
        this.ensureStreamAttached();
      }

      this.startAdaptiveLoop();
    } catch (err) {
      // ANY failure in start() — capture, connect, peer start, or a rejected/
      // timed-out join — must fully tear down so no dangling joined socket or
      // live advertised room is left behind. stop() stops the acquired stream,
      // closes the peer and the signaling client, and resets `started` so the
      // session can be retried.
      this.stop();
      throw err;
    }
  }

  /**
   * Resolve when the signaling server acknowledges our host `join` with `joined`;
   * reject if it replies `error` (e.g. message/code `host-exists` for a code
   * already held by a live host) or if no acknowledgement arrives within the
   * handshake timeout. The `join` is sent via `sendJoin` AFTER the listeners are
   * wired so the reply can never be missed. CONNECT-TIME HANDSHAKE ONLY — it
   * imposes no session duration limit.
   */
  private awaitHostJoinAck(
    signaling: SignalingClient,
    sendJoin: () => void,
  ): Promise<RTCIceServer[]> {
    const timeoutMs = this.opts.joinTimeoutMs ?? JOIN_ACK_TIMEOUT_MS;
    return new Promise<RTCIceServer[]>((resolve, reject) => {
      let settled = false;
      // Capture the server-distributed ICE list (if any) off the `joined` ack so
      // the host negotiates against the SAME STUN/TURN config as the viewer.
      // Validate before trusting it; a malformed field is ignored (LAN-only).
      const onJoined = (m: SignalMessage): void => {
        const ice = isIceServerList(m.iceServers) ? m.iceServers : [];
        finish(undefined, ice);
      };
      const onError = (m: SignalMessage): void =>
        finish(new HostJoinRejectedError(m.message ?? 'signaling host join rejected'));
      const finish = (err?: Error, ice: RTCIceServer[] = []): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signaling.off('joined', onJoined);
        signaling.off('error', onError);
        if (err) reject(err);
        else resolve(ice);
      };
      const timer = setTimeout(
        () =>
          finish(
            new HostJoinRejectedError(
              `Timed out after ${timeoutMs}ms waiting for the signaling server to ` +
                `acknowledge the host join for code "${this.opts.code}".`,
            ),
          ),
        timeoutMs,
      );
      signaling.on('joined', onJoined);
      signaling.on('error', onError);
      sendJoin();
    });
  }

  /**
   * Resolve the ICE servers (STUN/TURN) to use for this session's {@link Peer}.
   *
   * Precedence per the "connect from anywhere" design: the server-distributed
   * list on the `joined` ack wins (so BOTH peers negotiate against the same
   * STUN/TURN config), falling back to the LOCAL override from
   * {@link HostSessionOptions.iceServers} (env STREAMSCREEN_ICE_SERVERS, parsed
   * in main). When neither supplies any, the result is `[]` — LAN-only, no ICE
   * servers, behavior unchanged. Pure: no side effects, easy to unit-test.
   */
  private resolveIceServers(fromJoinedAck: RTCIceServer[]): RTCIceServer[] {
    if (fromJoinedAck.length > 0) return fromJoinedAck;
    return this.opts.iceServers ?? [];
  }

  /**
   * Route a single inbound {@link InputEvent} from `viewerId`.
   *
   * Almost everything flows straight to {@link HostSessionOptions.onInput} for
   * per-event OS injection. The ONE exception is the Ctrl+Alt+Del chord: the
   * viewer toolbar's SAS button (and the AI `press_combo`) emit the chord over
   * the ordinary input channel as individual key events, but Ctrl+Alt+Del
   * replayed as synthetic key presses is IGNORED by the Windows Secure Attention
   * Sequence (SAS) on the secure desktop. So when we see the chord's signature —
   * a `k-down` for Delete with BOTH Ctrl and Alt held — we route the canonical
   * {@link CTRL_ALT_DEL} sequence to the combo/SAS path ({@link
   * HostSessionOptions.onCombo}, wired to the main process's SendSAS) EXACTLY
   * ONCE and SUPPRESS the synthetic per-key replay of that Delete event. The
   * paired modifier/Delete `k-up`s (mods no longer hold Ctrl+Alt on release, or
   * carry no Delete) flow through normally and harmlessly.
   *
   * Software-initiated SAS on Windows requires the "SoftwareSASGeneration" group
   * policy to be enabled on the host; without it SendSAS no-ops (documented in
   * input-injector and the README). Routing is correct either way; with the
   * policy off the combo path simply falls back to the synthetic replay.
   *
   * If no {@link HostSessionOptions.onCombo} is provided we leave behavior
   * unchanged (forward the event to {@link HostSessionOptions.onInput}).
   */
  private routeInput(e: InputEvent, viewerId: string): void {
    // ACCESS GATING: in any non-'open' mode, DROP every input event from a viewer
    // that is not yet authorized. This is the fail-closed default — a viewer that
    // has not passed the required PIN/consent for the active mode can never drive
    // the host's input, even if the data channel is somehow open. 'open' mode
    // authorizes everyone (legacy behavior), so this never blocks there.
    if (!this.isAuthorized(viewerId)) return;
    if (this.opts.onCombo && isCtrlAltDelKeyDown(e)) {
      this.opts.onCombo(CTRL_ALT_DEL, viewerId);
      return; // suppress the synthetic per-key replay of the Ctrl+Alt+Del chord
    }
    this.opts.onInput(e, viewerId);
  }

  /**
   * Idempotently attach the captured stream SESSION-WIDE (to every existing
   * connection + replayed onto any future one). Used ONLY by 'open' mode, where
   * there is no per-viewer gating and every viewer is meant to receive the
   * screen. Protected modes never call this — they attach per authorized viewer
   * via {@link Peer.attachStreamTo} (see {@link authorizeViewer}) so the stream
   * is never replayed to an unapproved or later-joining viewer.
   */
  private ensureStreamAttached(): void {
    if (this.streamAttached) return;
    const peer = this.peer;
    const stream = this.stream;
    if (!peer || !stream) return;
    peer.attachStream(stream);
    this.streamAttached = true;
  }

  /**
   * Lockout/consent identity for a viewer. The renderer has no raw source IP, so
   * the DTLS CHANNEL BINDING (stable per DTLS session, distinct per transport)
   * serves as the network-source surrogate in the lockout key, combined with the
   * signaling peer id. A re-terminated-DTLS MITM gets a different binding (and a
   * failing proof anyway), so this is a sound, fail-closed identity.
   */
  private lockoutKeyFor(viewerId: string, channelBinding: string): {
    ip: string;
    peerId: string;
  } {
    return { ip: channelBinding || 'unknown', peerId: viewerId };
  }

  /**
   * Begin the access handshake for a freshly-joined viewer in a non-'open' mode.
   *
   * - 'refuse': never authorize (a misconfigured PIN mode); send a failure and
   *   leave the viewer un-attached. Fail-closed.
   * - 'prompt': no PIN — run the {@link ConsentManager} only; on Accept,
   *   authorize + attach; otherwise deny.
   * - 'pin' / 'pin-and-prompt': send an auth-challenge with a fresh host nonce
   *   plus the verifier's salt/iterations and the canonical channel binding. The
   *   viewer replies with an auth-response handled in {@link handleControl}.
   *
   * The challenge/consent run over the encrypted control channel; signaling
   * never carries any secret.
   */
  private beginAuth(viewerId: string, name?: string): void {
    const peer = this.peer;
    if (!peer) return;

    // Fail-closed: a PIN mode without a verifier (should not happen — config
    // refuses to enter the mode — but be defensive) refuses the viewer.
    if (this.accessMode === 'refuse' || (modeRequiresPin(this.accessMode) && !this.verifier)) {
      peer.sendControl({ t: 'auth-result', v: 1, ok: false }, viewerId);
      this.opts.onAuthResult?.(viewerId, false);
      return;
    }

    if (this.accessMode === 'prompt') {
      // Prompt-only: ask the host human. The channel binding still identifies the
      // transport for the consent record.
      const cb = peer.getChannelBinding(viewerId);
      // P2-1: notify the viewer BEFORE running consent so it enters
      // 'authenticating' and shows the "waiting for host approval" overlay.
      // No PIN proof is expected in prompt mode, so the challenge carries no
      // proof material (mode:'prompt' per the auth-challenge contract).
      peer.sendControl({ t: 'auth-challenge', v: 1, mode: 'prompt' }, viewerId);
      void this.runConsentThenAuthorize(viewerId, { peerId: viewerId, name, channelBinding: cb });
      return;
    }

    // PIN modes: issue the challenge. verifier is guaranteed present here.
    this.sendPinChallenge(viewerId);
  }

  /**
   * Issue (or RE-issue) a PIN auth-challenge to a viewer with a FRESH host nonce.
   * Stores the new nonce as the viewer's pending challenge (replacing any prior
   * one) and sends the challenge with the verifier's salt/iterations, the
   * canonical channel binding, and the effective PIN challenge mode.
   *
   * Re-used by {@link beginAuth} (first challenge) and by the P2-2 retry path:
   * after a failed-but-NOT-locked PIN attempt the host re-sends a fresh challenge
   * so the viewer can retry WITHOUT reconnecting (the consumed nonce is replaced
   * by a brand-new one).
   */
  private sendPinChallenge(viewerId: string): void {
    const peer = this.peer;
    if (!peer || !this.verifier) return;
    const record = this.verifier;
    const challengeMode = challengeModeOf(this.accessMode);
    if (!challengeMode || challengeMode === 'prompt') return; // pin modes only
    const nonceH = randomBytes(NONCE_BYTES);
    this.pendingChallenges.set(viewerId, nonceH);
    peer.sendControl(
      {
        t: 'auth-challenge',
        v: 1,
        nonceH: toBase64(nonceH),
        salt: record.salt,
        iterations: record.iterations,
        channelBinding: peer.getChannelBinding(viewerId),
        mode: challengeMode,
      },
      viewerId,
    );
  }

  /**
   * Run the human-Accept consent for a viewer and, on accept, authorize +
   * attach. On reject/timeout, deny (send a reason-free failure). Shared by the
   * 'prompt' path and the second stage of 'pin-and-prompt'.
   */
  private async runConsentThenAuthorize(viewerId: string, peerInfo: PeerInfo): Promise<void> {
    const decision = await this.consent.request(peerInfo);
    if (decision === 'accept') {
      await this.authorizeViewer(viewerId);
    } else {
      this.denyViewer(viewerId);
    }
  }

  /**
   * Handle a viewer's auth-response in a PIN mode: check lockout + verify the
   * proof against the host nonce and channel binding. On a valid proof, if the
   * mode also requires a human Accept ('pin-and-prompt') run the consent gate;
   * otherwise authorize directly. On any failure, bump the lockout and deny.
   */
  private async handleAuthResponse(
    m: Extract<ControlMessage, { t: 'auth-response' }>,
    viewerId: string,
  ): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    if (!modeRequiresPin(this.accessMode) || !this.verifier) {
      // Unexpected auth-response (mode needs no PIN); ignore — fail-closed.
      return;
    }
    const nonceH = this.pendingChallenges.get(viewerId);
    if (!nonceH) {
      // No outstanding challenge for this viewer — never issued one or already
      // consumed. Reject without running the KDF.
      this.denyViewer(viewerId);
      return;
    }

    const channelBinding = peer.getChannelBinding(viewerId);
    const outcome = await this.authVerifier.verify({
      record: this.verifier,
      proof: m.proof,
      nonceH,
      nonceV: m.nonceV,
      channelBinding,
      domain: AUTH_DOMAIN,
      key: this.lockoutKeyFor(viewerId, channelBinding),
    });

    if (!outcome.ok) {
      // The host nonce is single-use: drop it so the consumed nonce can never be
      // replayed. Bump already happened in verify.
      this.pendingChallenges.delete(viewerId);
      this.denyViewer(viewerId);
      // P2-2: if the viewer is NOT (now) locked out, re-issue a FRESH challenge
      // (new nonceH) so it can retry without reconnecting. A locked key (reason
      // 'locked', or a non-locked failure that just tripped the threshold ->
      // retryAfterMs > 0) gets NO fresh challenge: the viewer shows locked/denied
      // and must wait out the backoff. sendPinChallenge replaces the (deleted)
      // pending nonce with a brand-new one.
      const lockedOut = outcome.reason === 'locked' || outcome.retryAfterMs > 0;
      if (!lockedOut) {
        this.sendPinChallenge(viewerId);
      }
      return;
    }

    // Proof valid. Consume the nonce.
    this.pendingChallenges.delete(viewerId);

    if (modeRequiresPrompt(this.accessMode)) {
      // 'pin-and-prompt': also require a human Accept.
      await this.runConsentThenAuthorize(viewerId, {
        peerId: viewerId,
        name: m.name,
        channelBinding,
      });
      return;
    }
    await this.authorizeViewer(viewerId);
  }

  /**
   * Mark a viewer authorized: attach media to ONLY this viewer + accept input +
   * ack. The media attach is PER viewer (P1-B): {@link Peer.attachStreamTo}
   * adds tracks to exactly this connection and does NOT set the session-wide
   * localStream, so the screen is never replayed onto another existing
   * connection nor auto-attached to a later/unapproved viewer. (Open mode uses
   * the session-wide {@link ensureStreamAttached} instead — handled in start().)
   * The ack is sent only after the attach renegotiation has been kicked off.
   */
  private async authorizeViewer(viewerId: string): Promise<void> {
    this.authorizedViewers.add(viewerId);
    const peer = this.peer;
    const stream = this.stream;
    if (peer && stream) {
      await peer.attachStreamTo(viewerId, stream);
    }
    peer?.sendControl({ t: 'auth-result', v: 1, ok: true }, viewerId);
    this.opts.onAuthResult?.(viewerId, true);
  }

  /** Deny a viewer: send a reason-free failure; never attach media or input. */
  private denyViewer(viewerId: string): void {
    this.authorizedViewers.delete(viewerId);
    this.peer?.sendControl({ t: 'auth-result', v: 1, ok: false }, viewerId);
    this.opts.onAuthResult?.(viewerId, false);
  }

  /**
   * Get (or lazily create) the inbound {@link FileTransferManager} for one
   * viewer. Per-viewer managers keep concurrent transfers from different viewers
   * from colliding on transfer ids / chunk sequences, and route the file-accept /
   * progress control replies back to that specific viewer.
   */
  private fileManagerFor(viewerId: string): FileTransferManager {
    let mgr = this.fileManagers.get(viewerId);
    if (!mgr) {
      mgr = new FileTransferManager(
        (data, meta) => this.opts.onFileReceived?.(data, meta, viewerId),
        (msg) => this.peer?.sendControl(msg, viewerId),
        true, // auto-accept inbound offers; the host UI can be added later.
      );
      this.fileManagers.set(viewerId, mgr);
    }
    return mgr;
  }

  /**
   * Route an inbound {@link ControlMessage} from `viewerId`. File-transfer frames
   * are delegated to that viewer's {@link FileTransferManager}; replies (monitors,
   * monitor-switched) go back to the requesting viewer specifically.
   */
  private async handleControl(m: ControlMessage, viewerId: string): Promise<void> {
    // AUTH FRAMES are handled regardless of authorization state — they ARE the
    // authorization. An auth-response from a viewer drives the PIN verification.
    if (m.t === 'auth-response') {
      await this.handleAuthResponse(m, viewerId);
      return;
    }
    // auth-challenge / auth-result are host->viewer only; ignore if a viewer
    // sends them (a malformed/hostile peer).
    if (m.t === 'auth-challenge' || m.t === 'auth-result') return;

    // ACCESS GATING: in a non-'open' mode, ignore ALL other control frames from a
    // viewer that is not yet authorized (file transfer, monitor switch, quality,
    // chat, etc). They must pass the access gate first. Fail-closed.
    if (!this.isAuthorized(viewerId)) return;

    // Let the originating viewer's file manager observe its control frames.
    this.fileManagerFor(viewerId).onControl(m);
    switch (m.t) {
      case 'chat':
        this.opts.onChat?.(m.text, m.ts, viewerId);
        break;
      case 'request-monitors': {
        const list = (await this.opts.getMonitors?.()) ?? [];
        this.peer?.sendControl({ t: 'monitors', list }, viewerId);
        break;
      }
      case 'switch-monitor':
        await this.switchMonitor(m.id);
        break;
      case 'audio':
        this.setAudioEnabled(m.enabled);
        break;
      case 'quality':
        this.applyQualityPreset(m.preset);
        break;
      case 'latency':
        // Record this viewer's reported end-to-end interactive latency. It is
        // folded (worst-case across viewers) into the next adaptive tick's stats
        // so the host governs on true end-to-end latency, not just its own
        // sender-side measurement. Non-finite values are ignored defensively
        // (the protocol validates, but be robust to a hand-rolled sender).
        if (Number.isFinite(m.rttMs) && Number.isFinite(m.playoutMs)) {
          this.viewerLatency.set(viewerId, {
            rttMs: Math.max(0, m.rttMs),
            playoutMs: Math.max(0, m.playoutMs),
          });
        }
        break;
      default:
        break;
    }
  }

  /**
   * Switch the shared monitor at runtime: re-capture the requested source and
   * swap the outbound video track via `replaceVideoTrack` (NO renegotiation), so
   * the adaptive loop keeps running uninterrupted. The freshly captured audio
   * track (if any) is dropped — audio loopback is desktop-wide, not per-monitor,
   * so the existing audio sender stays untouched. Confirms with `monitor-switched`.
   */
  async switchMonitor(sourceId: string): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    const acquire = this.opts.acquireStream ?? getDisplayStream;
    // Capture video only for the switch; existing audio sender is preserved.
    const next = await acquire(sourceId, this.opts.capture, false);
    const videoTrack = next.getVideoTracks()[0];
    if (!videoTrack) return;
    // Carry the screen-content hint onto the swapped-in track too.
    hintScreenContent(videoTrack);

    // Snapshot the OLD video tracks BEFORE replaceVideoTrack runs. The Peer
    // shares the very same MediaStream object we passed to attachStream, and
    // replaceVideoTrack mutates it in place — adding `videoTrack` and removing
    // the previous ones. If we read this.stream.getVideoTracks() AFTER the
    // swap, it would contain the new active track, and stopping those would end
    // the replacement track (freezing the viewer). Capture the originals first.
    const oldVideoTracks = this.stream
      ? this.stream.getVideoTracks().filter((t) => t !== videoTrack)
      : [];

    // replaceVideoTrack returns FALSE when there are no RTCRtpSenders yet — i.e.
    // NO viewers are connected. We must NOT treat that as a no-op: the operator
    // still changed the source, and the freshly-captured `videoTrack` must become
    // the new active/queued stream so the NEXT viewer to connect (which replays
    // this.stream / the Peer's stored localStream via attachStream) gets the
    // CHOSEN source, not the original default. So whether or not a live sender
    // was swapped, we ALWAYS adopt `videoTrack` into the shared stream, stop the
    // OLD track(s) (don't leak them), and update activeSourceId. The ONLY thing
    // gated on `replaced` is whether any sender's track was hot-swapped — and
    // replaceVideoTrack handled that already. Critically, we do NOT stop the new
    // `videoTrack` in the no-viewer case: it is now the active queued stream.
    await peer.replaceVideoTrack(videoTrack);

    // Adopt the new video track into the shared stream and stop ONLY the old
    // video track(s) — never the new active `videoTrack`. The Peer holds the
    // SAME MediaStream object (passed via attachStream), so mutating it here
    // also updates what future connections replay. replaceVideoTrack may have
    // already adopted `videoTrack` (when it swapped a live sender); guard the
    // add so we never duplicate it, and never re-stop the new one.
    if (this.stream) {
      for (const t of oldVideoTracks) {
        this.stream.removeTrack(t);
        t.stop();
      }
      if (!this.stream.getVideoTracks().includes(videoTrack)) {
        this.stream.addTrack(videoTrack);
      }
    } else {
      this.stream = next;
    }

    this.activeSourceId = sourceId;
    this.opts.onActiveDisplay?.(sourceId);
    peer.sendControl({ t: 'monitor-switched', id: sourceId });
  }

  /**
   * Change the shared CAPTURE SOURCE at runtime IN PLACE — the host operator
   * picking a different screen from the source dropdown.
   *
   * This MUST NOT leave and rejoin the signaling room. The earlier renderer
   * implementation tore the whole session down (`stop()`, which closes the
   * signaling socket) and immediately constructed a fresh {@link HostSession}
   * with the SAME code. Because {@link stop} returns BEFORE the signaling server
   * has observed the host's departure, the new join could race ahead and be
   * rejected as `host-exists` (duplicate host codes are rejected), leaving the
   * operator with NO advertised session after a source switch.
   *
   * Instead we reuse the very same in-place mechanism as a monitor switch:
   * re-capture the chosen source and swap the outbound video track via
   * `replaceVideoTrack` (NO renegotiation, NO signaling leave/rejoin). The
   * room/code/socket stay joined and advertised across the change, so the
   * `host-exists` race cannot happen at all. There is no session time limit or
   * usage cap involved anywhere here.
   *
   * No-op if the requested source is already the active one (avoids a needless
   * re-capture + track swap). Delegates to {@link switchMonitor}, which is the
   * authoritative in-place re-capture + track-replace path.
   */
  async switchSource(sourceId: string): Promise<void> {
    if (sourceId === this.activeSourceId) return;
    await this.switchMonitor(sourceId);
  }

  /**
   * Enable/disable the outbound system-audio track in response to a viewer
   * `{t:'audio'}` toggle. Disabling mutes by setting `track.enabled=false`
   * (keeps the sender so re-enabling needs no renegotiation).
   */
  setAudioEnabled(enabled: boolean): void {
    const stream = this.stream;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  /**
   * Send a file from the host to the viewer over the reliable `file` channel,
   * with control-channel offer/accept/progress/complete and SCTP backpressure.
   * The viewer drives acceptance by replying `file-accept` (routed in
   * {@link handleControl} via the sender registered here).
   */
  async sendFile(
    file: OutboundFile,
    onProgress?: (sent: number, total: number) => void,
    viewerId?: string,
  ): Promise<void> {
    const peer = this.peer;
    if (!peer) throw new Error('HostSession.sendFile: session not started');
    const id = `host-${Date.now()}-${this.outboundSeq++}`;
    const meta: FileMeta = { id, name: file.name, size: file.data.byteLength, mime: file.mime };
    let sender: FileSender | null = createSender({
      meta,
      data: file.data,
      send: (msg) => peer.sendControl(msg, viewerId),
      sendChunk: (buf) => peer.sendFileChunk(buf, viewerId),
      drain: () => peer.drainFile(viewerId),
      onProgress,
    });
    // The viewer's file-accept / file-reject arrives on the control channel. When
    // targeting one viewer, only that viewer's reply (matched by id + sender)
    // should drive the transfer; on a broadcast, the first accept releases it.
    const onCtl = (m: ControlMessage, fromViewer: string): void => {
      if (viewerId !== undefined && fromViewer !== viewerId) return;
      if (m.t === 'file-accept' && m.id === id) sender?.accept();
      else if ((m.t === 'file-reject' || m.t === 'file-error') && m.id === id) {
        sender?.abort(m.t === 'file-error' ? m.message : 'rejected by viewer');
      }
    };
    // Register the per-transfer routing handler and capture its disposer so we
    // can remove it the instant the transfer settles. Without this, the closure
    // (and through it the sender, which retains the whole file's framed chunks)
    // would stay alive on the Peer's handler set until the session stops, so
    // every completed/aborted host->viewer send leaks its file bytes — repeated
    // large sends grow renderer memory unbounded.
    const removeCtl = peer.onControl(onCtl);
    try {
      await sender.start();
    } finally {
      removeCtl();
      // Drop the sender reference so its cached framed chunks become eligible
      // for GC; the now-removed closure no longer pins them either.
      sender = null;
    }
  }

  /** Send a chat message to the viewer. */
  sendChat(text: string): void {
    this.peer?.sendControl({ t: 'chat', text, ts: Date.now() });
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
   * Worst-case (max) viewer-reported end-to-end latency across all viewers, or
   * null if no viewer has reported yet. Folded into the stats each tick so the
   * host governs on true end-to-end interactive latency, not just its own
   * sender-side measurement. MAX = pessimistic = real-time-protective.
   */
  private worstReportedLatency(): { rttMs: number; playoutMs: number } | null {
    if (this.viewerLatency.size === 0) return null;
    let rttMs = 0;
    let playoutMs = 0;
    for (const r of this.viewerLatency.values()) {
      if (r.rttMs > rttMs) rttMs = r.rttMs;
      if (r.playoutMs > playoutMs) playoutMs = r.playoutMs;
    }
    return { rttMs, playoutMs };
  }

  /**
   * One iteration of the adaptive loop: sample stats, FOLD IN viewer-reported
   * end-to-end latency, compute a decision, and apply it ASYMMETRICALLY (the
   * fast-down / slow-up policy). Safe to call manually in tests. Swallows
   * transient stats errors (e.g. before the connection is up) so the loop never
   * dies.
   *
   * Fast-down / slow-up — we ALWAYS prioritize real-time:
   *   - DECREASE / HOLD apply IMMEDIATELY this very tick.
   *   - INCREASE applies only after {@link INCREASE_CONFIRM_TICKS} consecutive
   *     increase classifications (a sustained clean link, ~2s at 500ms), gated
   *     by a deterministic counter; any non-increase decision resets the count.
   *
   * The controller stays authoritative: its math is untouched, including the
   * internal bitrate it advances on every `update()`. The host only chooses
   * WHEN to push the increase to the encoder, never WHAT the value is.
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

    // Fold viewer-reported end-to-end latency (worst case across viewers) into
    // the measured stats: take the MAX of measured vs reported for both the
    // network RTT and the receiver playout delay. This makes the controller
    // back off on true end-to-end interactive latency even when the host's own
    // sender-side RTT looks fine (e.g. receiver-side jitter-buffer queueing).
    const reported = this.worstReportedLatency();
    if (reported) {
      stats = {
        ...stats,
        rttMs: Math.max(stats.rttMs, reported.rttMs),
        playoutMs: Math.max(stats.playoutMs ?? 0, reported.playoutMs),
      };
    }

    const decision = this.controller.update(stats);
    this.lastDecision = decision;

    // ASYMMETRIC APPLICATION (fast-down / slow-up). The controller has already
    // advanced its internal bitrate; we only gate whether to push an INCREASE.
    const phase = decisionPhase(decision);
    let apply: boolean;
    if (phase === 'INCREASE') {
      this.consecutiveIncreases += 1;
      if (this.consecutiveIncreases >= INCREASE_CONFIRM_TICKS) {
        apply = true;
        this.consecutiveIncreases = 0; // committed — restart the confirmation window
      } else {
        apply = false; // not yet sustained; hold the encoder steady
      }
    } else {
      // HOLD / DECREASE / unrecognized: apply immediately and reset the gate so
      // a future ramp must re-earn a full N-in-a-row clean streak.
      this.consecutiveIncreases = 0;
      apply = true;
    }

    if (apply) {
      try {
        await peer.applyDecision(decision);
      } catch {
        // Sender may not be ready yet; the next tick retries.
      }
    }
    this.opts.onDecision?.(decision, stats);
  }

  /** Tear down the adaptive loop, peer, stream, and signaling. Idempotent. */
  stop(): void {
    if (this.adaptiveTimer) {
      clearInterval(this.adaptiveTimer);
      this.adaptiveTimer = null;
    }
    if (this.disposeControlOpen) {
      this.disposeControlOpen();
      this.disposeControlOpen = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.signaling = null;
    this.fileManagers.clear();
    this.viewerLatency.clear();
    this.authorizedViewers.clear();
    this.pendingChallenges.clear();
    this.viewerNames.clear();
    this.consent.clear();
    this.lockout.clear();
    this.streamAttached = false;
    this.consecutiveIncreases = 0;
    this.started = false;
  }
}

/**
 * Map a {@link QualityPreset} to AdaptiveController bounds (kbps).
 *
 * The CEILING (`maxKbps`) is what actually throttles the stream: the AIMD engine
 * can never ramp a decision above it. Presets step the ceiling down progressively
 * so 'low' produces a strictly lower target bitrate than 'balanced' < 'high' <
 * 'auto'. 'auto' keeps the engine's full, unlimited adaptive range.
 *
 * Exported for unit testing the monotonic ordering of the ceilings.
 */
export function qualityBounds(preset: QualityPreset): { minKbps: number; maxKbps: number } {
  switch (preset) {
    case 'high':
      return { minKbps: 300, maxKbps: 12_000 };
    case 'balanced':
      return { minKbps: 300, maxKbps: 4_000 };
    case 'low':
      return { minKbps: 300, maxKbps: 1_200 };
    case 'auto':
    default:
      // Full adaptive range — matches AdaptiveController's defaults (40 Mbps).
      return { minKbps: 300, maxKbps: 40_000 };
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
