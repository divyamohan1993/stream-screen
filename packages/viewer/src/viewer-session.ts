import {
  Peer,
  SignalingClient,
  isValidSessionCode,
  isIceServerList,
  createSender,
  FileTransferManager,
  AUTH_DOMAIN,
  deriveKey,
  computeProof,
  fromBase64,
  toBase64,
  randomBytes,
  NONCE_BYTES,
  type AdaptiveStats,
  type InputEvent,
  type SignalMessage,
  type ControlMessage,
  type MonitorInfo,
  type FileMeta,
  type QualityPreset as CoreQualityPreset,
} from '@stream-screen/core';
import type { QualityPreset } from './quality.js';

/**
 * Map a viewer UI quality preset (`Auto`/`High`/`Balanced`/`Low`) to the
 * lowercase wire-protocol {@link CoreQualityPreset} the host understands.
 */
function toWirePreset(preset: QualityPreset): CoreQualityPreset {
  return preset.toLowerCase() as CoreQualityPreset;
}

/** Connection lifecycle states surfaced to the UI. */
export type SessionState =
  | 'idle'
  | 'connecting'
  | 'waiting-for-host'
  | 'reconnecting'
  | 'authenticating'
  | 'connected'
  | 'disconnected'
  | 'denied'
  | 'error';

/**
 * Access mode advertised by the host in an {@link AuthChallenge}. `'open'` is
 * the absence of a challenge (no auth) — it never appears in a challenge frame
 * and so is intentionally NOT part of this union.
 */
export type AuthMode = 'prompt' | 'pin' | 'pin-and-prompt';

/**
 * What the viewer must do to satisfy the host's inbound auth challenge.
 * Surfaced to the UI so it can render the right affordance:
 *  - `'prompt'`: a non-interactive "waiting for host approval" notice; the host
 *    operator must Accept. No PIN field — the viewer sends no proof.
 *  - `'pin'` / `'pin-and-prompt'`: a PIN entry field; on submit the viewer
 *    derives the proof and sends an `auth-response`.
 */
export interface AuthChallenge {
  mode: AuthMode;
  /** True when a PIN proof is required (`'pin'` / `'pin-and-prompt'`). */
  needsPin: boolean;
}

/** A chat message as surfaced to the UI (origin + text + timestamp). */
export interface ChatEntry {
  from: 'host' | 'me';
  text: string;
  ts: number;
}

/** Lifecycle of an inbound or outbound file transfer, surfaced to the UI. */
export interface FileTransferEntry {
  id: string;
  name: string;
  size: number;
  mime: string;
  direction: 'in' | 'out';
  /** Bytes transferred so far. */
  progress: number;
  status: 'offered' | 'active' | 'complete' | 'error' | 'rejected';
  error?: string;
}

/** Callbacks the UI registers to react to session events. */
export interface ViewerSessionHandlers {
  /** Connection lifecycle changed. */
  onState?: (state: SessionState, detail?: string) => void;
  /** The remote video stream arrived (attach to a <video>). */
  onStream?: (stream: MediaStream) => void;
  /** A fresh stats snapshot is available (polled each tick). */
  onStats?: (stats: AdaptiveStats) => void;
  /** Host pushed clipboard text we should mirror locally. */
  onClipboard?: (text: string) => void;
  /** A chat message arrived (from the host) or was sent (echoed locally). */
  onChat?: (entry: ChatEntry) => void;
  /** The host advertised its list of capturable monitors. */
  onMonitors?: (list: MonitorInfo[]) => void;
  /** The host confirmed the active monitor changed. */
  onMonitorSwitched?: (id: string) => void;
  /** A file transfer changed state (offered/active/progress/complete/error). */
  onFileTransfer?: (entry: FileTransferEntry) => void;
  /** An inbound file completed and is ready to download. */
  onFileReady?: (data: Uint8Array, meta: FileMeta) => void;
  /**
   * The host requires authorization before the session may proceed (an inbound
   * `auth-challenge` arrived). The UI shows the appropriate consent/PIN
   * affordance. Fires again on a fresh challenge after a denial (retry). Never
   * fires in `'open'` access mode (no challenge is sent).
   */
  onAuthRequired?: (challenge: AuthChallenge) => void;
  /**
   * The host returned its auth verdict. `ok:true` ⇒ the session proceeds and the
   * (possibly already-arrived) video is released; `ok:false` ⇒ access denied,
   * the UI offers a retry. Reason-free by protocol design.
   */
  onAuthResult?: (ok: boolean) => void;
}

/** Options for opening a viewer session. */
export interface ViewerSessionOptions {
  /** Session code (6–9 digits) advertised by the host. */
  code: string;
  /** WebSocket signaling URL, e.g. `ws://192.168.1.5:8787`. */
  signalingUrl: string;
  /** Display name shown to the host. Defaults to `web-viewer`. */
  name?: string;
  /**
   * Optional LOCAL ICE-server override (STUN/TURN). OPT-IN; LAN-first defaults
   * leave this empty (host candidates only, no third-party servers). When the
   * signaling server distributes an ICE list on the `joined` ack, that
   * server-distributed list is used so BOTH peers match; this local override
   * takes precedence over it (and over the LAN-only default) when provided,
   * letting an operator point a single viewer at a known STUN/TURN set without
   * reconfiguring the server. Absent/empty everywhere => LAN-only, unchanged.
   */
  iceServers?: RTCIceServer[];
  /** Stats polling interval, ms. Defaults to 1000. */
  statsIntervalMs?: number;
  /**
   * Grace period (ms) to wait after the peer enters `disconnected` before
   * tearing the peer down and rebuilding it. A transient blip (WiFi roam, brief
   * AP loss) usually self-heals back to `connected` within this window. Defaults
   * to 4000.
   */
  reconnectGraceMs?: number;
  /**
   * Override the connect-time handshake timeout (ms) — how long {@link
   * ViewerSession.connect} (and the ICE-reconnect rebuild) waits for the
   * signaling server's `joined` acknowledgement before aborting. Purely a
   * connect handshake bound; NOT a session time limit. Defaults to {@link
   * VIEWER_JOIN_ACK_TIMEOUT_MS}.
   */
  joinTimeoutMs?: number;
  /** Handlers for session events. */
  handlers?: ViewerSessionHandlers;
}

const DEFAULT_STATS_INTERVAL_MS = 1000;
const DEFAULT_RECONNECT_GRACE_MS = 4000;

/**
 * Default time (ms) {@link ViewerSession.connect} (and the ICE-reconnect rebuild
 * path) waits for the signaling server's `joined` acknowledgement after sending
 * the viewer `join`, before aborting.
 *
 * This is a CONNECT-TIME HANDSHAKE TIMEOUT ONLY — it bounds the wait for the
 * server to confirm we actually entered the room. It is emphatically NOT a
 * session duration limit or usage cap: once joined, the session runs until the
 * user closes it.
 */
export const VIEWER_JOIN_ACK_TIMEOUT_MS = 10_000;

/**
 * Thrown when the viewer's signaling `join` is rejected by the server (e.g. the
 * code names no live session, or the room is full — `no-such-session`) or no
 * `joined` acknowledgement arrives within {@link VIEWER_JOIN_ACK_TIMEOUT_MS}.
 */
export class ViewerJoinRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewerJoinRejectedError';
  }
}

/**
 * Derive the signaling WebSocket URL from the current page origin when one is
 * not supplied explicitly. Mirrors the page host so LAN access "just works".
 */
export function defaultSignalingUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:8787';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.hostname || 'localhost';
  return `${proto}//${host}:8787`;
}

/**
 * Drives a viewer-side StreamScreen session end to end:
 *
 *  1. connect to signaling and `join` the room by `code` (role 'viewer'),
 *  2. start the {@link Peer} and accept the host's WebRTC offer,
 *  3. surface the inbound remote video track to the UI,
 *  4. poll {@link AdaptiveStats} on an interval for the live dashboard,
 *  5. relay {@link InputEvent}s to the host over the input data channel.
 *
 * The viewer never imposes time limits or bitrate caps — it is purely a sink
 * for the host's stream and a source of input. Encryption is handled by the
 * WebRTC stack (DTLS-SRTP); the session is gated only by the numeric code.
 */
export class ViewerSession {
  private readonly opts: ViewerSessionOptions;
  private readonly handlers: ViewerSessionHandlers;
  private signaling: SignalingClient | null = null;
  private peer: Peer | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private state: SessionState = 'idle';
  private stream: MediaStream | null = null;
  private closed = false;
  private fileManager: FileTransferManager | null = null;
  /** Active outbound senders keyed by transfer id, so inbound accept/reject route correctly. */
  private readonly outboundSenders = new Map<string, ReturnType<typeof createSender>>();
  /**
   * Grace timer armed when the peer enters `disconnected`. If it fires (the blip
   * did not self-heal) we rebuild the peer; cleared if we recover or hard-fail.
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against overlapping rebuilds while one is already in flight. */
  private rebuilding = false;
  /**
   * The most recent inbound `auth-challenge`, retained so {@link submitPin} can
   * derive the proof against the host's salt/nonce/iterations/channelBinding.
   * Cleared once consumed (a response is sent) or on teardown.
   */
  private pendingChallenge:
    | Extract<ControlMessage, { t: 'auth-challenge' }>
    | null = null;
  /**
   * True once the host has required authorization (a challenge arrived) and we
   * are not yet authorized. While set, the session is GATED: the remote video is
   * withheld and the lifecycle is held at `authenticating` (never `connected`)
   * until an `auth-result{ok:true}` arrives. In `'open'` mode no challenge ever
   * arrives, so this stays false and behavior is unchanged.
   */
  private authRequired = false;
  /** True once the host returned `auth-result{ok:true}`; ungates the session. */
  private authorized = false;
  /**
   * A remote stream that arrived BEFORE authorization completed. Held back (not
   * surfaced to the UI) until `auth-result{ok:true}` so unauthorized video is
   * never rendered, then released. In `'open'` mode streams pass straight
   * through and this stays null.
   */
  private pendingStream: MediaStream | null = null;
  /**
   * ICE servers distributed by the signaling server on the most recent `joined`
   * ack (the server-distributed STUN/TURN list — see {@link
   * isIceServerList}). Captured during the join handshake and used to build the
   * {@link Peer} so BOTH host and viewer negotiate against the SAME config. A
   * local {@link ViewerSessionOptions.iceServers} override, when supplied, takes
   * precedence over this. `null` until a `joined` ack has been observed; an empty
   * array means the server explicitly distributed no servers (LAN-only).
   */
  private serverIceServers: RTCIceServer[] | null = null;

  constructor(opts: ViewerSessionOptions) {
    this.opts = opts;
    this.handlers = opts.handlers ?? {};
  }

  /**
   * The ICE servers this session will (or did) build its {@link Peer} with: the
   * local {@link ViewerSessionOptions.iceServers} override when non-empty,
   * otherwise the server-distributed list from the `joined` ack, otherwise an
   * empty array (LAN-only default). Returns a defensive copy. Exposed for the UI
   * and for tests asserting the configured negotiation set.
   */
  get effectiveIceServers(): RTCIceServer[] {
    const local = this.opts.iceServers;
    const chosen = local && local.length > 0 ? local : (this.serverIceServers ?? []);
    return chosen.map((s) => ({ ...s }));
  }

  /** Current lifecycle state. */
  get currentState(): SessionState {
    return this.state;
  }

  /**
   * The auth challenge the session is currently awaiting a response to, if any —
   * e.g. so the UI can decide whether to render a PIN field. `null` in `'open'`
   * mode and once authorization has completed.
   */
  get currentAuthChallenge(): AuthChallenge | null {
    const c = this.pendingChallenge;
    if (!c) return null;
    // `mode` is optional on the wire and defaults to 'pin' for back-compat.
    const mode = c.mode ?? 'pin';
    return { mode, needsPin: mode === 'pin' || mode === 'pin-and-prompt' };
  }

  /**
   * Update lifecycle state and notify the UI.
   *
   * DEFENSE IN DEPTH against superseded connects (FINDING P2): once the session
   * has been torn down (`closed`), a late state emission from an OLD, canceled
   * attempt must never reach the UI. If the user retries or picks another host
   * while a previous `connect()` is still awaiting the socket/join, App disconnects
   * that old session — but the rejected async path of the OLD session would still
   * call `setState('error', …)`, and App's GLOBAL state handler would bounce a
   * newer connecting/connected session back to 'error'. So `setState` is a NO-OP
   * once `closed`.
   *
   * The two INTENTIONAL terminal emissions that run as part of teardown itself —
   * `disconnect()` surfacing 'disconnected' and the connect()/rebuild error paths
   * surfacing 'error' — pass `force: true` so they are emitted exactly once even
   * though they set `closed`. Any subsequent (late, superseded) setState is then
   * suppressed by the guard.
   */
  private setState(state: SessionState, detail?: string, force = false): void {
    if (this.closed && !force) return;
    this.state = state;
    this.handlers.onState?.(state, detail);
  }

  /**
   * Handle a signaling `peer-left`. Per the SHARED SIGNALING CONTRACT,
   * `peer-left` carries the departed peer's `role`. In a multi-viewer room the
   * server emits `peer-left` for ANY peer, including OTHER viewers — those must
   * NOT downgrade us to `waiting-for-host`, because the host stream is still
   * connected. Only an actual HOST departure (`role === 'host'`) returns the
   * session to `waiting-for-host`. Genuine host loss is also covered by the peer
   * connection-state path (`failed`/`disconnected`).
   */
  private onPeerLeft(m: SignalMessage): void {
    if (this.closed) return;
    if (m.role !== 'host') return;
    this.setState('waiting-for-host', 'Host left the session.');
  }

  /**
   * Connect, join the room, and begin negotiation. Resolves once signaling is
   * connected and the join has been sent; media/connection events continue to
   * arrive via handlers.
   */
  async connect(): Promise<void> {
    if (!isValidSessionCode(this.opts.code)) {
      this.setState('error', 'Invalid code — must be 6 to 9 digits.');
      throw new Error('ViewerSession: invalid session code');
    }
    this.closed = false;
    this.setState('connecting');

    const signaling = new SignalingClient(this.opts.signalingUrl);
    this.signaling = signaling;

    signaling.on('peer-left', (m: SignalMessage) => {
      this.onPeerLeft(m);
    });

    try {
      await signaling.connect();
      // Join the room by code, as a viewer, then WAIT for the server's `joined`
      // acknowledgement before we resolve / enter waiting-for-host / start the
      // stats loop. Per the shared signaling contract the server replies `joined`
      // on success or `error` (e.g. `no-such-session` when the code names no live
      // host, or a full room) otherwise. Without this handshake a rejected join
      // would still resolve connect() and start the stats loop, while the
      // SignalingClient's remembered `lastJoin` keeps reconnecting and REPLAYING
      // the rejected join. A rejection or a handshake timeout throws and is fully
      // cleaned up by the catch below.
      await this.awaitJoinAck(signaling, () => {
        signaling.join({
          code: this.opts.code,
          role: 'viewer',
          name: this.opts.name ?? 'web-viewer',
        });
      });
      // Surface `waiting-for-host` BEFORE building/starting the peer. P2-1: on a
      // fast LAN the host's `offer` can already be sitting buffered in the core
      // SignalingClient (it buffers unhandled offer/answer/ice and REPLAYS them
      // the instant a handler registers). `peer.start()` wires the offer handler,
      // so that buffered offer is processed synchronously inside start() — which
      // can drive the peer straight to `connected`/`authenticating`. Emitting
      // `waiting-for-host` AFTER start() would then CLOBBER that more-advanced
      // state back to waiting and leave the viewer stuck. So we set
      // `waiting-for-host` first, then build+start; any immediate state the
      // replayed offer produces lands afterward and sticks.
      this.setState('waiting-for-host', 'Joined — waiting for host stream.');
      // Build + start the Peer AFTER the join ack so it is constructed with the
      // SAME ICE config the server distributed to both peers (captured into
      // `serverIceServers` during the handshake). The host does not emit its
      // offer until it observes our `peer-joined` (routed only AFTER our join is
      // acknowledged); a fast offer that still beats our handler is buffered by
      // core and replayed when start() registers the peer's `offer` handler, so
      // it is never dropped. Local override > server list > LAN-only default.
      const peer = this.buildPeer(signaling);
      await peer.start();
      // Only AFTER a confirmed join do we install the persistent signaling error
      // handler (so a later signaling error surfaces as session error) and begin
      // the session. Wiring it before the handshake would let the join-ack's own
      // `error` rejection AND this handler both fire on the same rejection.
      signaling.on('error', (m: SignalMessage) => {
        if (this.closed) return;
        this.setState('error', m.message ?? 'Signaling error');
      });
      this.startStatsLoop();
    } catch (err) {
      // Was this session ALREADY torn down before the failure surfaced? That is
      // the superseded case (FINDING P2): the user retried / picked another host
      // while this connect() was still awaiting the socket/join, App called
      // disconnect() on us, and only NOW does our awaited path reject. We must NOT
      // emit a late 'error' — App's global state handler would otherwise bounce a
      // newer connecting/connected session back to 'error'.
      const supersededBeforeFailure = this.closed;
      // ANY failure — connect, peer start, a rejected join such as
      // `no-such-session`, or a join-ack timeout — must fully tear down so no
      // dangling joined socket is left whose remembered join the SignalingClient
      // could reconnect and replay. disconnect() closes the peer and CLOSES the
      // SignalingClient (clearing its reconnect schedule) and stops the loop.
      // (No-op if we were already disconnected externally.)
      this.disconnect();
      // Only emit the connect-failure 'error' for a session that was still live
      // when it failed. `force` is needed because disconnect() (just above) marks
      // the session closed; the superseded guard above already excludes the
      // late/stale case, so this never resurrects a torn-down session's state.
      if (!supersededBeforeFailure) {
        this.setState('error', err instanceof Error ? err.message : 'Failed to connect', true);
      }
      throw err;
    }
  }

  /**
   * Resolve when the signaling server acknowledges our viewer `join` with
   * `joined`; reject if it replies `error` (e.g. `no-such-session` for a code
   * that names no live host, or a full room) or if no acknowledgement arrives
   * within the handshake timeout. The `join` is sent via `sendJoin` AFTER the
   * listeners are wired so the reply can never be missed. CONNECT-TIME HANDSHAKE
   * ONLY — it imposes no session duration limit.
   */
  private awaitJoinAck(signaling: SignalingClient, sendJoin: () => void): Promise<void> {
    const timeoutMs = this.opts.joinTimeoutMs ?? VIEWER_JOIN_ACK_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onJoined = (m: SignalMessage): void => {
        // Capture the server-distributed ICE list (if any) so the Peer is built
        // to negotiate against the SAME STUN/TURN config as the host. Validate
        // defensively: a malformed field is ignored (LAN-only). An absent field
        // leaves the prior value untouched (additive/backward-compatible).
        if (isIceServerList(m.iceServers)) {
          this.serverIceServers = m.iceServers.map((s) => ({ ...s }));
        }
        finish();
      };
      const onError = (m: SignalMessage): void =>
        finish(new ViewerJoinRejectedError(m.message ?? 'signaling viewer join rejected'));
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signaling.off('joined', onJoined);
        signaling.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new ViewerJoinRejectedError(
              `Timed out after ${timeoutMs}ms waiting for the signaling server to ` +
                `acknowledge the viewer join for code "${this.opts.code}".`,
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
   * Create a fresh {@link Peer} over the current signaling client and wire all
   * of its event handlers (track, connection state, input, file, control). Used
   * both for the initial connect and for transparent reconnection after a hard
   * ICE failure. Does NOT call `peer.start()`; the caller decides when to begin
   * negotiation.
   */
  private buildPeer(signaling: SignalingClient): Peer {
    const peer = new Peer({
      role: 'viewer',
      signaling,
      // Negotiate against the SAME STUN/TURN config as the host: prefer a local
      // override, else the server-distributed list from the `joined` ack, else
      // none (LAN-only default). `effectiveIceServers` returns a defensive copy.
      iceServers: this.effectiveIceServers,
    });
    this.peer = peer;

    peer.on('track', (_track: MediaStreamTrack, stream: MediaStream) => {
      if (!stream) return;
      this.stream = stream;
      // GATING: if the host required auth and we are not yet authorized, withhold
      // the video — never render an unauthorized stream. Hold it until
      // `auth-result{ok:true}` releases it. In `'open'` mode (no challenge,
      // authRequired stays false) the stream passes straight through.
      if (this.authRequired && !this.authorized) {
        this.pendingStream = stream;
        return;
      }
      this.handlers.onStream?.(stream);
    });

    peer.on('state', (connState: RTCPeerConnectionState) => {
      this.onPeerState(connState);
    });

    // Input data channel inbound frames: only clipboard is meaningful viewer-side.
    peer.onInput((e: InputEvent) => {
      if (e.t === 'clipboard') this.handlers.onClipboard?.(e.text);
    });

    // File transfer: receive inbound chunks/offers; surface the assembled bytes.
    this.fileManager = new FileTransferManager(
      (data, meta) => this.handlers.onFileReady?.(data, meta),
      (m) => peer.sendControl(m),
      // Auto-accept inbound offers: the viewer always wants the host's files (it
      // surfaces a browser download). Progress is reported via onProgress hooks.
      true,
    );
    peer.onFileChunk((buf: ArrayBuffer) => {
      // P2 (defensive): drop inbound file chunks while still gated. We never
      // accepted a gated offer, so any chunk arriving now is for a transfer we
      // are refusing — discard it rather than assembling unauthorized bytes.
      if (this.isFileGated()) return;
      this.fileManager?.onChunk(buf);
    });

    // Control channel: chat, monitors, file-transfer signaling.
    peer.onControl((m: ControlMessage) => this.handleControl(m));

    return peer;
  }

  /**
   * React to a peer connection-state change with reconnection handling:
   *  - `connected`: clear any pending grace timer and surface `connected`.
   *  - `disconnected`: a (possibly transient) path drop. Surface `reconnecting`
   *    and arm a grace timer; if the path self-heals back to `connected` the
   *    timer is cancelled, otherwise it rebuilds the peer.
   *  - `failed`: ICE is dead and will not recover on its own — rebuild the peer
   *    immediately (re-join is replayed by the SignalingClient, and the host
   *    re-offers when our fresh peer announces itself).
   *  - `closed`: terminal unless we initiated the teardown.
   */
  private onPeerState(connState: RTCPeerConnectionState): void {
    if (this.closed) return;
    switch (connState) {
      case 'connected':
        this.clearReconnectTimer();
        // GATING: if the host required auth and we are not yet authorized, hold
        // the lifecycle at `authenticating` rather than reporting `connected`.
        // The auth handshake runs over the control channel that opens with this
        // connection; only `auth-result{ok:true}` advances us to `connected`.
        if (this.authRequired && !this.authorized) {
          this.setState('authenticating');
        } else {
          this.setState('connected');
        }
        break;
      case 'disconnected':
        // Don't tear down yet: most blips (WiFi roam, brief AP loss) recover.
        this.setState('reconnecting', 'Connection interrupted — recovering…');
        this.armReconnectTimer();
        break;
      case 'failed':
        this.setState('reconnecting', 'Connection lost — reconnecting…');
        void this.rebuildPeer();
        break;
      case 'closed':
        if (!this.rebuilding) this.setState('disconnected');
        break;
      default:
        break;
    }
  }

  /** Arm the grace timer that rebuilds the peer if `disconnected` doesn't self-heal. */
  private armReconnectTimer(): void {
    if (this.reconnectTimer) return;
    const grace = this.opts.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.rebuildPeer();
    }, grace);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Tear down the dead peer and stand up a fresh one, rebuilding signaling
   * membership so the host re-offers to the new peer.
   *
   * The old signaling socket is still `join`ed to the room from the perspective
   * of the SignalingServer, which rejects a second `join` on the same socket as
   * `already-joined` — so simply calling `join()` again would never trigger a
   * fresh host offer. Instead we CLOSE the existing SignalingClient and open a
   * brand-new one, then `join()` on the fresh socket. The host therefore observes
   * `peer-left` (old socket closed) followed by a fresh `peer-joined` and emits a
   * new offer to our rebuilt peer.
   *
   * This is a transparent recovery, NOT a session end: the grace timer that
   * triggers it must never tear the session down. Idempotent while a rebuild is
   * in flight.
   */
  private async rebuildPeer(): Promise<void> {
    if (this.closed || this.rebuilding) return;
    if (!this.signaling) return;
    this.rebuilding = true;
    this.clearReconnectTimer();
    this.setState('reconnecting', 'Reconnecting…');
    // A fresh peer means the host re-runs its auth handshake from scratch. Reset
    // the gate so an authorized prior session can't bypass re-authorization on
    // the rebuilt connection; the host's new challenge re-arms it. (In `'open'`
    // mode no challenge arrives, so this is a no-op for the lifecycle.)
    this.authRequired = false;
    this.authorized = false;
    this.pendingChallenge = null;
    this.pendingStream = null;
    try {
      // Closing the old peer fires `closed`; `rebuilding` guards it from being
      // mistaken for a user-initiated teardown.
      this.peer?.close();
      this.peer = null;

      // Close the stale, already-joined signaling socket and open a fresh one so
      // the host sees peer-left then peer-joined and re-offers. Re-using the same
      // socket would be rejected as `already-joined` and the rebuilt peer would
      // never receive a new offer.
      this.signaling?.close();
      const signaling = new SignalingClient(this.opts.signalingUrl);
      this.signaling = signaling;
      signaling.on('peer-left', (m: SignalMessage) => {
        this.onPeerLeft(m);
      });

      await signaling.connect();
      // Announce ourselves on the fresh socket and AWAIT the `joined`
      // acknowledgement before treating the rebuilt peer as live — don't start
      // relying on a rebuilt peer before it has actually re-joined the room. A
      // rejection (e.g. the host has since gone away — `no-such-session`) or a
      // handshake timeout throws to the catch below. CONNECT-TIME bound only.
      // The ack also refreshes the server-distributed ICE list so the rebuilt
      // peer keeps negotiating against the SAME STUN/TURN config.
      await this.awaitJoinAck(signaling, () => {
        signaling.join({
          code: this.opts.code,
          role: 'viewer',
          name: this.opts.name ?? 'web-viewer',
        });
      });
      // Build + start the rebuilt peer AFTER the ack so it picks up the (possibly
      // refreshed) server-distributed ICE config, mirroring the initial connect.
      const peer = this.buildPeer(signaling);
      await peer.start();
      // Re-install the persistent signaling error handler only after the rebuilt
      // socket has confirmed its re-join.
      signaling.on('error', (m: SignalMessage) => {
        if (this.closed) return;
        this.setState('error', m.message ?? 'Signaling error');
      });
    } catch (err) {
      // The rebuild's fresh join was REJECTED or TIMED OUT (e.g. the host left
      // during the reconnect grace period). Mirror connect()'s join-error
      // teardown discipline: the freshly-created peer and signaling are left
      // dangling otherwise — the SignalingClient remembers the failed join and
      // keeps reconnecting and REPLAYING it while the UI is already in 'error',
      // and the stats loop (armed back at connect()) keeps polling. Fully tear
      // down: close the fresh peer AND signaling (so lastJoin is never
      // reconnected/replayed) and stop the stats loop, leaving the session
      // cleanly in 'error'. This is a hard failure (the room is gone), NOT a
      // transparent recovery, so the session ends here — it imposes no time
      // limit; the path is reached only on a real join rejection/timeout.
      this.teardownForError();
      // `force`: teardownForError() marked the session closed, but this 'error' is
      // the intentional terminal state for a failed rebuild.
      this.setState('error', err instanceof Error ? err.message : 'Reconnection failed', true);
    } finally {
      this.rebuilding = false;
    }
  }

  /**
   * Tear down all live resources after an unrecoverable failure (e.g. the ICE
   * rebuild's fresh join was rejected/timed out). Closes the peer and the
   * SignalingClient — closing the socket clears its reconnect schedule so a
   * remembered `lastJoin` can never be reconnected/replayed — and stops the
   * stats loop. Marks the session `closed` so no further peer-state event acts.
   * Leaves state-setting to the caller (so it can surface `error`). Mirrors
   * {@link disconnect}'s teardown without forcing a `disconnected` state.
   */
  private teardownForError(): void {
    this.closed = true;
    this.clearReconnectTimer();
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const sender of this.outboundSenders.values()) sender.abort('disconnected');
    this.outboundSenders.clear();
    this.fileManager = null;
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.signaling = null;
    this.stream = null;
    this.pendingStream = null;
    this.pendingChallenge = null;
  }

  private startStatsLoop(): void {
    if (this.statsTimer) return;
    const interval = this.opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
    this.statsTimer = setInterval(() => {
      void this.pollStats();
    }, interval);
  }

  private async pollStats(): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    try {
      const stats = await peer.getStats();
      this.handlers.onStats?.(stats);
      // Real-time telemetry: report our observed END-TO-END interactive latency
      // (network rttMs + receiver playout/jitter-buffer delay) plus fps back to
      // the host over the control channel. The host folds this into its adaptive
      // controller so receiver-side queueing forces real-time backoff — the
      // viewer is the only side that can measure inbound playout delay. Reuse the
      // stats already gathered this tick (no extra getStats round-trip) via the
      // core telemetry shape. `sendControl` itself no-ops while the control
      // channel is not open, so this is safe before negotiation completes.
      peer.sendControl({
        t: 'latency',
        rttMs: stats.rttMs,
        playoutMs: stats.playoutMs ?? 0,
        fps: stats.fps,
      });
    } catch {
      /* transient stats error — ignore this tick */
    }
  }

  /**
   * Whether inbound host file transfers must be refused right now. True while the
   * session is GATED — the host required authorization (an `auth-challenge`
   * arrived) and we have not yet received `auth-result{ok:true}`. In `'open'` mode
   * no challenge ever arrives, so `authRequired` stays false and this returns
   * false (inbound files flow as today). Once authorized this returns false too.
   */
  private isFileGated(): boolean {
    return this.authRequired && !this.authorized;
  }

  /**
   * Route an inbound {@link ControlMessage}. File-offer/complete and inbound
   * chunks are delegated to the {@link FileTransferManager}; file-accept/reject
   * release/abort our outbound senders; chat/monitors are surfaced to the UI.
   */
  private handleControl(m: ControlMessage): void {
    switch (m.t) {
      case 'chat':
        this.handlers.onChat?.({ from: 'host', text: m.text, ts: m.ts });
        break;
      case 'monitors':
        this.handlers.onMonitors?.(m.list);
        break;
      case 'monitor-switched':
        this.handlers.onMonitorSwitched?.(m.id);
        break;
      case 'file-offer':
        // P2 (defensive): never auto-accept or process an inbound host file
        // until we are authorized. In a protected mode the control/file channels
        // are open while the auth handshake is still pending, so a host could push
        // a file before its `auth-result{ok:true}`. While the session is GATED
        // (auth required and not yet authorized) we DROP the offer outright: do not
        // create a receiver, do not auto-ACCEPT, do not surface it to the UI. In
        // `'open'` mode no challenge ever arrives so this never gates.
        if (this.isFileGated()) break;
        // Let the manager create the receiver; surface the offer to the UI.
        this.fileManager?.onControl(m);
        this.handlers.onFileTransfer?.({
          id: m.id,
          name: m.name,
          size: m.size,
          mime: m.mime,
          direction: 'in',
          progress: 0,
          status: 'active',
        });
        break;
      case 'file-complete':
        // Gated: ignore stray completes for an offer we never accepted.
        if (this.isFileGated()) break;
        this.fileManager?.onControl(m);
        this.handlers.onFileTransfer?.({
          id: m.id,
          name: '',
          size: 0,
          mime: '',
          direction: 'in',
          progress: 0,
          status: 'complete',
        });
        break;
      case 'file-accept': {
        // Host accepted one of our outbound offers — release the chunk stream.
        const sender = this.outboundSenders.get(m.id);
        sender?.accept();
        break;
      }
      case 'file-reject':
      case 'file-error': {
        const sender = this.outboundSenders.get(m.id);
        sender?.abort(m.t === 'file-error' ? m.message : 'rejected by host');
        this.outboundSenders.delete(m.id);
        this.handlers.onFileTransfer?.({
          id: m.id,
          name: '',
          size: 0,
          mime: '',
          direction: 'out',
          progress: 0,
          status: m.t === 'file-error' ? 'error' : 'rejected',
          error: m.t === 'file-error' ? m.message : undefined,
        });
        break;
      }
      case 'file-progress':
        // Gated: ignore inbound progress for a push we are not accepting.
        if (this.isFileGated()) break;
        // Inbound progress for a transfer the host is pushing to us.
        this.handlers.onFileTransfer?.({
          id: m.id,
          name: '',
          size: 0,
          mime: '',
          direction: 'in',
          progress: m.received,
          status: 'active',
        });
        break;
      case 'auth-challenge':
        this.onAuthChallenge(m);
        break;
      case 'auth-result':
        this.onAuthResult(m.ok);
        break;
      default:
        break;
    }
  }

  /**
   * Handle an inbound `auth-challenge`: the host requires authorization before
   * the session may proceed. Mark the session GATED, retain the challenge so a
   * subsequent {@link submitPin} can derive the proof, surface the right UI
   * affordance, and (defensively) hold the lifecycle at `authenticating` even if
   * we already reached the peer `connected` state.
   *
   * For a `'prompt'`-only challenge there is no PIN: the host operator must
   * Accept, so we immediately send a proof-less `auth-response` carrying only our
   * display name and wait for the verdict. For `'pin'`/`'pin-and-prompt'` we wait
   * for the user to enter the PIN via {@link submitPin}.
   */
  private onAuthChallenge(m: Extract<ControlMessage, { t: 'auth-challenge' }>): void {
    if (this.closed) return;
    this.authRequired = true;
    this.authorized = false;
    this.pendingChallenge = m;
    // `mode` is optional on the wire and defaults to 'pin' for back-compat.
    const mode = m.mode ?? 'pin';
    const needsPin = mode === 'pin' || mode === 'pin-and-prompt';
    // Hold the lifecycle at `authenticating` (the control channel only opens
    // after the peer connects, so we are typically already at `connected` here
    // in the gated sense; surface the gate explicitly).
    this.setState('authenticating');
    this.handlers.onAuthRequired?.({ mode, needsPin });
    if (!needsPin) {
      // Prompt-only: no secret to prove. Send a proof-less response so the host
      // can associate our display name; the human Accept drives the verdict.
      this.peer?.sendControl({
        t: 'auth-response',
        v: 1,
        nonceV: toBase64(randomBytes(NONCE_BYTES)),
        proof: '',
        name: this.opts.name ?? 'web-viewer',
      });
    }
  }

  /**
   * Handle the host's `auth-result` verdict. On success ungate the session:
   * release any video that arrived while gated and advance to `connected`. On
   * failure surface `denied`.
   *
   * P2-2: on a denial we DISCARD the pending challenge. Its nonce has been
   * consumed by the response the host just rejected — the host deletes that
   * nonce on a failed attempt, so resubmitting a proof against it would always
   * fail. {@link submitPin} therefore no-ops (Retry is inert) until a FRESH
   * `auth-challenge` (new nonce) arrives via {@link onAuthChallenge}, which
   * re-arms the session. If the host instead locks the viewer out (no fresh
   * challenge follows), the session simply stays `denied` with nothing to
   * resubmit — exactly the locked-out state.
   */
  private onAuthResult(ok: boolean): void {
    if (this.closed) return;
    this.handlers.onAuthResult?.(ok);
    if (ok) {
      this.authorized = true;
      this.pendingChallenge = null;
      this.setState('connected');
      // Release any stream that arrived while we were gated.
      if (this.pendingStream) {
        const s = this.pendingStream;
        this.pendingStream = null;
        this.handlers.onStream?.(s);
      }
    } else {
      // Access denied. Stay gated and DROP the consumed challenge so a stale
      // nonce can never be resubmitted; a retry is only possible once the host
      // sends a fresh `auth-challenge` (which re-arms `pendingChallenge`).
      this.authorized = false;
      this.pendingChallenge = null;
      this.setState('denied', 'Access denied.');
    }
  }

  /**
   * Submit a user-entered PIN in response to the pending `auth-challenge`. Derives
   * the PBKDF2 key from the host's salt/iterations, computes the bound proof
   * (domain ‖ nonceH ‖ a fresh nonceV ‖ the LOCALLY-computed DTLS channel
   * binding), and sends the `auth-response`. The PIN is used only to derive the
   * proof and is NEVER stored — the local string goes out of scope as soon as the
   * key is derived.
   *
   * The channel binding is recomputed locally via {@link Peer.getChannelBinding}
   * so it matches the host's value without ever transiting signaling; a binding
   * mismatch (e.g. a re-terminated-DTLS MITM) yields a proof the host rejects.
   *
   * No-op if there is no pending challenge or it is prompt-only. After a denial
   * the pending challenge is dropped (its nonce is consumed/deleted host-side),
   * so this no-ops until a FRESH `auth-challenge` re-arms the session — Retry
   * never resubmits a proof against a consumed nonce.
   */
  async submitPin(pin: string): Promise<void> {
    const challenge = this.pendingChallenge;
    const peer = this.peer;
    if (!challenge || !peer) return;
    if (challenge.mode !== 'pin' && challenge.mode !== 'pin-and-prompt') return;
    const salt = fromBase64(challenge.salt);
    const nonceH = fromBase64(challenge.nonceH);
    const nonceV = randomBytes(NONCE_BYTES);
    // Derive then immediately drop the PIN reference (never persisted anywhere).
    const key = await deriveKey(pin, salt, challenge.iterations);
    const channelBinding = peer.getChannelBinding();
    const proof = await computeProof(key, {
      domain: AUTH_DOMAIN,
      nonceH,
      nonceV,
      channelBinding,
    });
    // The challenge has been consumed; on a denial the host sends a FRESH
    // challenge (new nonce) which re-arms us — we never resubmit this nonce.
    peer.sendControl({
      t: 'auth-response',
      v: 1,
      nonceV: toBase64(nonceV),
      proof: toBase64(proof),
      name: this.opts.name ?? 'web-viewer',
    });
  }

  /** Send an input event to the host (no-op if the channel is not open). */
  sendInput(e: InputEvent): void {
    this.peer?.sendInput(e);
  }

  /**
   * Send an ordered list of {@link InputEvent}s (e.g. a key combo produced by
   * `buildKeyCombo`/`SPECIAL_KEYS`) to the host over the input channel.
   */
  sendInputSequence(events: InputEvent[]): void {
    for (const e of events) this.peer?.sendInput(e);
  }

  /** Send a {@link ControlMessage} to the host (no-op if not connected). */
  sendControl(m: ControlMessage): void {
    this.peer?.sendControl(m);
  }

  /** Send a chat message to the host and echo it locally. */
  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ts = Date.now();
    this.peer?.sendControl({ t: 'chat', text: trimmed, ts });
    this.handlers.onChat?.({ from: 'me', text: trimmed, ts });
  }

  /** Ask the host to enumerate its capturable monitors. */
  requestMonitors(): void {
    this.peer?.sendControl({ t: 'request-monitors' });
  }

  /** Ask the host to switch the active captured monitor. */
  switchMonitor(id: string): void {
    this.peer?.sendControl({ t: 'switch-monitor', id });
  }

  /** Toggle host system-audio capture on/off. */
  setAudioEnabled(enabled: boolean): void {
    this.peer?.sendControl({ t: 'audio', enabled });
  }

  /**
   * Request a quality preset from the host. The viewer's UI presets
   * (`Auto`/`High`/`Balanced`/`Low`) are mapped to the wire-protocol's lowercase
   * {@link CoreQualityPreset} discriminants and sent as a `{t:'quality',preset}`
   * control frame, so the host's authoritative adaptive controller can apply the
   * requested ceiling. No-op if the control channel is not open. This imposes no
   * time limit and no hard cap below what the link can carry — it only adjusts
   * the adaptive ceiling on the host side.
   */
  setQuality(preset: QualityPreset): void {
    this.peer?.sendControl({ t: 'quality', preset: toWirePreset(preset) });
  }

  /**
   * Offer a file to the host. Streams it over the reliable binary `file` channel
   * with backpressure once the host accepts. Returns the transfer id.
   */
  sendFile(file: { name: string; size: number; type: string }, data: Uint8Array): string {
    const peer = this.peer;
    if (!peer) throw new Error('ViewerSession: cannot send file before connecting');
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const meta: FileMeta = { id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
    this.handlers.onFileTransfer?.({
      id,
      name: meta.name,
      size: meta.size,
      mime: meta.mime,
      direction: 'out',
      progress: 0,
      status: 'offered',
    });
    const sender = createSender({
      meta,
      data,
      send: (msg) => peer.sendControl(msg),
      sendChunk: (buf) => peer.sendFileChunk(buf),
      drain: () => peer.drainFile(),
      onProgress: (received, total) => {
        this.handlers.onFileTransfer?.({
          id,
          name: meta.name,
          size: total,
          mime: meta.mime,
          direction: 'out',
          progress: received,
          status: 'active',
        });
      },
    });
    this.outboundSenders.set(id, sender);
    void sender
      .start()
      .then(() => {
        this.outboundSenders.delete(id);
        this.handlers.onFileTransfer?.({
          id,
          name: meta.name,
          size: meta.size,
          mime: meta.mime,
          direction: 'out',
          progress: meta.size,
          status: 'complete',
        });
      })
      .catch((err) => {
        this.outboundSenders.delete(id);
        this.handlers.onFileTransfer?.({
          id,
          name: meta.name,
          size: meta.size,
          mime: meta.mime,
          direction: 'out',
          progress: 0,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return id;
  }

  /** The current remote stream, if one has arrived. */
  get remoteStream(): MediaStream | null {
    return this.stream;
  }

  /** Tear down the session: stop stats, close peer + signaling. Idempotent. */
  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearReconnectTimer();
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const sender of this.outboundSenders.values()) sender.abort('disconnected');
    this.outboundSenders.clear();
    this.fileManager = null;
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.signaling = null;
    this.stream = null;
    this.pendingStream = null;
    this.pendingChallenge = null;
    // `force`: `closed` was set at the top of this method, but this terminal
    // 'disconnected' emission is the intentional one for a user-initiated teardown.
    this.setState('disconnected', undefined, true);
  }
}
