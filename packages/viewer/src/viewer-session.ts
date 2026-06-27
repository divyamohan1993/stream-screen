import {
  Peer,
  SignalingClient,
  isValidSessionCode,
  createSender,
  FileTransferManager,
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
  | 'connected'
  | 'disconnected'
  | 'error';

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
}

/** Options for opening a viewer session. */
export interface ViewerSessionOptions {
  /** Session code (6–9 digits) advertised by the host. */
  code: string;
  /** WebSocket signaling URL, e.g. `ws://192.168.1.5:8787`. */
  signalingUrl: string;
  /** Display name shown to the host. Defaults to `web-viewer`. */
  name?: string;
  /** Optional ICE servers (LAN-first: usually empty / host-candidate only). */
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

  constructor(opts: ViewerSessionOptions) {
    this.opts = opts;
    this.handlers = opts.handlers ?? {};
  }

  /** Current lifecycle state. */
  get currentState(): SessionState {
    return this.state;
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

    this.buildPeer(signaling);

    try {
      await signaling.connect();
      await this.peer!.start();
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
      // Only AFTER a confirmed join do we install the persistent signaling error
      // handler (so a later signaling error surfaces as session error) and begin
      // the session. Wiring it before the handshake would let the join-ack's own
      // `error` rejection AND this handler both fire on the same rejection.
      signaling.on('error', (m: SignalMessage) => {
        if (this.closed) return;
        this.setState('error', m.message ?? 'Signaling error');
      });
      this.setState('waiting-for-host', 'Joined — waiting for host stream.');
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
      const onJoined = (): void => finish();
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
      iceServers: this.opts.iceServers,
    });
    this.peer = peer;

    peer.on('track', (_track: MediaStreamTrack, stream: MediaStream) => {
      if (stream) {
        this.stream = stream;
        this.handlers.onStream?.(stream);
      }
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
        this.setState('connected');
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

      const peer = this.buildPeer(signaling);
      await signaling.connect();
      await peer.start();
      // Announce ourselves on the fresh socket and AWAIT the `joined`
      // acknowledgement before treating the rebuilt peer as live — don't start
      // relying on a rebuilt peer before it has actually re-joined the room. A
      // rejection (e.g. the host has since gone away — `no-such-session`) or a
      // handshake timeout throws to the catch below. CONNECT-TIME bound only.
      await this.awaitJoinAck(signaling, () => {
        signaling.join({
          code: this.opts.code,
          role: 'viewer',
          name: this.opts.name ?? 'web-viewer',
        });
      });
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
      default:
        break;
    }
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
    // `force`: `closed` was set at the top of this method, but this terminal
    // 'disconnected' emission is the intentional one for a user-initiated teardown.
    this.setState('disconnected', undefined, true);
  }
}
