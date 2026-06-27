import type {
  AdaptiveDecision,
  AdaptiveStats,
  ControlMessage,
  InputEvent,
  Role,
  SignalMessage,
} from './protocol.js';
import { isControlMessage } from './protocol.js';
import type { SignalingClient } from './signaling-client.js';
import { decodeInput, encodeInput } from './input-codec.js';

/** Events emitted by a {@link Peer}. */
export type PeerEvent = 'track' | 'datachannel' | 'state' | 'stats';

/** Options for constructing a {@link Peer}. */
export interface PeerOptions {
  role: Role;
  signaling: SignalingClient;
  iceServers?: RTCIceServer[];
  /**
   * Optional `RTCPeerConnection` constructor. Defaults to
   * `globalThis.RTCPeerConnection`. Tests may inject a mock or a node WebRTC
   * implementation here (or set it on `globalThis`).
   */
  rtcPeerConnection?: typeof RTCPeerConnection;
}

type AnyCb = (...args: unknown[]) => void;

const INPUT_CHANNEL = 'input';
const CONTROL_CHANNEL = 'control';
const FILE_CHANNEL = 'file';

/**
 * Default `bufferedAmountLowThreshold` (bytes) for the binary `file` channel.
 * When the buffered amount drops below this the drain helper resolves, giving
 * file transfers SCTP-friendly backpressure instead of flooding the channel.
 */
const FILE_BUFFER_LOW = 256 * 1024;
/** Upper bound at which {@link Peer.drainFile} starts waiting for the buffer to flush. */
const FILE_BUFFER_HIGH = 1024 * 1024;

/**
 * Resolve the `RTCPeerConnection` constructor for the current runtime.
 */
function resolveRTC(opts: PeerOptions): typeof RTCPeerConnection {
  const ctor =
    opts.rtcPeerConnection ??
    (globalThis as unknown as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (typeof ctor !== 'function') {
    throw new Error(
      'Peer: no RTCPeerConnection available. Provide opts.rtcPeerConnection or run in a WebRTC-capable environment.',
    );
  }
  return ctor;
}

/**
 * All state for a single remote peer connection. The host keeps one of these
 * per viewer (keyed by the server-assigned remote id); the viewer keeps exactly
 * one (its host). Bundling the `RTCPeerConnection`, its data channels, its
 * trickled-ICE queue, and its perfect-negotiation bookkeeping together is what
 * makes multi-viewer fan-out correct: each viewer negotiates, receives media,
 * and is attributed input independently — a second viewer can no longer
 * overwrite the first's connection or collide on a shared input channel.
 */
interface RemoteConnection {
  /** Server-assigned id of the remote peer this connection talks to. */
  readonly remoteId: string;
  readonly pc: RTCPeerConnection;
  inputChannel: RTCDataChannel | null;
  controlChannel: RTCDataChannel | null;
  fileChannel: RTCDataChannel | null;
  // Perfect-negotiation bookkeeping (per connection).
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Early ICE candidates queued until the remote description is applied. */
  readonly pendingCandidates: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  /**
   * Set when `onnegotiationneeded` fired for this connection before it had been
   * registered (host adds tracks/data channels before any viewer is known). The
   * deferred offer is emitted once the connection is wired up.
   */
  negotiationPending: boolean;
}

/**
 * WebRTC peer wrapper around `RTCPeerConnection`.
 *
 * Drives offer/answer negotiation through a {@link SignalingClient} using the
 * perfect-negotiation pattern (the host is impolite and always wins glare; the
 * viewer is polite and rolls back). The host creates the offer once a viewer
 * joins; the viewer answers. ICE candidates are trickled over signaling.
 *
 * MULTI-VIEWER: the signaling server models "one host + N viewers per session
 * code" and relays per-target. This class mirrors that — the host maintains one
 * `RTCPeerConnection` (with its own senders + data channels) PER viewer, keyed
 * by the server's per-peer ids. Tracks attached via {@link attachStream} are
 * sent to every viewer; {@link applyDecision} fans an adaptive decision out to
 * all senders; inbound input is attributed to the originating viewer. A second
 * viewer joining no longer steals or breaks the first viewer's session (it gets
 * its own connection), so read-only "watch party" viewing and multi-controller
 * sessions both work. The viewer role keeps exactly one connection (its host).
 *
 * Media flows host → viewer over the negotiated video track(s); a reliable,
 * ordered `input` data channel carries {@link InputEvent}s viewer → host,
 * encoded with the input codec. Live {@link AdaptiveStats} are derived from the
 * WebRTC stats API, and {@link AdaptiveDecision}s are applied to the outbound
 * video sender's encoding parameters.
 *
 * DTLS-SRTP encryption is handled by the WebRTC stack. There are no session
 * time limits or bitrate caps imposed here — the only ceiling is whatever the
 * adaptive engine decides.
 */
export class Peer {
  private readonly role: Role;
  private readonly signaling: SignalingClient;
  private readonly iceServers: RTCIceServer[];
  private readonly RTC: typeof RTCPeerConnection;

  /** One {@link RemoteConnection} per remote peer, keyed by remote id. */
  private readonly connections = new Map<string, RemoteConnection>();
  /** Local media to send; replayed onto every connection (existing + future). */
  private localStream: MediaStream | null = null;
  /** True once {@link start} has run and {@link close} has not. */
  private running = false;

  private readonly listeners = new Map<PeerEvent, Set<AnyCb>>();
  private readonly inputHandlers = new Set<(e: InputEvent, remoteId: string) => void>();
  private readonly controlHandlers = new Set<(m: ControlMessage, remoteId: string) => void>();
  private readonly fileChunkHandlers = new Set<(buf: ArrayBuffer, remoteId: string) => void>();

  /**
   * Small playout latency target (seconds) applied to inbound video receivers to
   * minimize jitter-buffer delay for interactive remote control. Configurable
   * via {@link setJitterBufferTarget}.
   */
  private jitterBufferTargetMs = 0;

  /**
   * Per-connection cumulative jitter-buffer samples from the previous getStats
   * tick, keyed by remote id then by inbound-rtp ssrc/id. Used to compute a
   * delta-based average playout delay in ms (current jitterBufferDelay /
   * jitterBufferEmittedCount over just the last window), which is the
   * receive-side queueing component of end-to-end interactive latency.
   */
  private readonly jitterBufferPrev = new Map<
    string,
    Map<string, { delay: number; count: number }>
  >();

  // Perfect-negotiation: the host is impolite (wins glare); the viewer is polite.
  private readonly polite: boolean;

  constructor(opts: PeerOptions) {
    this.role = opts.role;
    this.signaling = opts.signaling;
    this.iceServers = opts.iceServers ?? [];
    this.RTC = resolveRTC(opts);
    // Host is impolite (wins glare and offers first); viewer is polite.
    this.polite = this.role === 'viewer';
  }

  /** Subscribe to a peer lifecycle/data event. */
  on(ev: PeerEvent, cb: Function): void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(cb as AnyCb);
  }

  private emit(ev: PeerEvent, ...args: unknown[]): void {
    const set = this.listeners.get(ev);
    if (set) for (const cb of set) cb(...args);
  }

  /**
   * Begin operation: wire signaling so that each `peer-joined` (host) or remote
   * offer/answer establishes a per-remote {@link RTCPeerConnection}. No
   * connection exists until a remote peer is known; the host creates its
   * data channels + replays media when a viewer joins, then offers.
   */
  async start(): Promise<void> {
    this.running = true;
    this.wireSignaling();
  }

  /**
   * Create (or return the existing) {@link RemoteConnection} for `remoteId`,
   * fully wiring its `RTCPeerConnection`: ICE trickle, track/datachannel/state
   * events, and (host) the outbound data channels + any already-attached media.
   */
  private ensureConnection(remoteId: string): RemoteConnection {
    const existing = this.connections.get(remoteId);
    if (existing) return existing;

    const pc = new this.RTC({ iceServers: this.iceServers });
    const conn: RemoteConnection = {
      remoteId,
      pc,
      inputChannel: null,
      controlChannel: null,
      fileChannel: null,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      negotiationPending: false,
    };
    this.connections.set(remoteId, conn);

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        this.signaling.send({
          type: 'ice',
          to: remoteId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (ev: RTCTrackEvent) => {
      // Minimize receive-side playout buffering for interactive control. The
      // standard knob is jitterBufferTarget (ms); fall back to the legacy
      // playoutDelayHint (seconds) where only that exists. Both are best-effort.
      this.applyJitterBufferTarget(ev.receiver);
      this.emit('track', ev.track, ev.streams[0], remoteId);
    };

    pc.onconnectionstatechange = () => {
      this.emit('state', pc.connectionState, remoteId);
    };

    pc.ondatachannel = (ev: RTCDataChannelEvent) => {
      switch (ev.channel.label) {
        case INPUT_CHANNEL:
          this.bindInputChannel(conn, ev.channel);
          break;
        case CONTROL_CHANNEL:
          this.bindControlChannel(conn, ev.channel);
          break;
        case FILE_CHANNEL:
          this.bindFileChannel(conn, ev.channel);
          break;
        default:
          break;
      }
      this.emit('datachannel', ev.channel, remoteId);
    };

    pc.onnegotiationneeded = () => {
      // Rely solely on this handler to make offers. The connection is registered
      // before any track/datachannel is added, so there is always a remote to
      // send to; collapse the createDataChannel + addTrack bursts into one offer.
      void this.negotiate(conn);
    };

    // Host owns data-channel creation so the viewer receives them via
    // ondatachannel; both sides end up with bound channels. Creating these
    // before any track means the negotiationneeded they trigger carries the
    // channels into the first offer to this viewer.
    if (this.role === 'host') {
      this.bindInputChannel(conn, pc.createDataChannel(INPUT_CHANNEL, { ordered: true }));
      this.bindControlChannel(conn, pc.createDataChannel(CONTROL_CHANNEL, { ordered: true }));
      this.bindFileChannel(conn, pc.createDataChannel(FILE_CHANNEL, { ordered: true }));
      // Replay any already-attached media onto this fresh connection so a viewer
      // that joins after attachStream() still receives the stream.
      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }
    }

    return conn;
  }

  /** Apply the configured jitter-buffer target to an inbound receiver (best-effort). */
  private applyJitterBufferTarget(receiver: RTCRtpReceiver | undefined): void {
    if (!receiver || this.jitterBufferTargetMs <= 0) return;
    const r = receiver as unknown as Record<string, unknown>;
    try {
      if ('jitterBufferTarget' in r) {
        r.jitterBufferTarget = this.jitterBufferTargetMs;
      } else if ('playoutDelayHint' in r) {
        r.playoutDelayHint = this.jitterBufferTargetMs / 1000;
      }
    } catch {
      /* not supported on this backend */
    }
  }

  /**
   * Set the receive-side playout latency target in milliseconds. A small value
   * (e.g. 0–50ms) trades smoothness for responsiveness — used by the low-latency
   * quality preset. Applies to existing and future inbound video receivers.
   */
  setJitterBufferTarget(ms: number): void {
    this.jitterBufferTargetMs = Math.max(0, ms);
    for (const conn of this.connections.values()) {
      for (const receiver of conn.pc.getReceivers()) {
        if (receiver.track?.kind === 'video') this.applyJitterBufferTarget(receiver);
      }
    }
  }

  private wireSignaling(): void {
    this.signaling.on('peer-joined', (m: SignalMessage) => {
      if (!m.from) return;
      // Only the host proactively stands up a connection + offers when a viewer
      // joins. A viewer learns of the host the same way but waits for the host's
      // offer (it is polite and never offers first), so it just registers the id.
      if (this.role === 'host') {
        const conn = this.ensureConnection(m.from);
        // The createDataChannel/addTrack above fire negotiationneeded, which
        // drives exactly one offer per connection (single offer path, no glare).
        if (conn.negotiationPending || this.localStream) {
          conn.negotiationPending = false;
          void this.negotiate(conn);
        }
      } else {
        this.ensureConnection(m.from);
      }
    });

    this.signaling.on('peer-left', (m: SignalMessage) => {
      if (!m.from) return;
      const conn = this.connections.get(m.from);
      if (!conn) return;
      this.connections.delete(m.from);
      this.closeConnection(conn);
    });

    this.signaling.on('offer', (m: SignalMessage) => {
      if (!m.from) return;
      const conn = this.ensureConnection(m.from);
      void this.handleDescription(conn, m.sdp);
    });

    this.signaling.on('answer', (m: SignalMessage) => {
      if (!m.from) return;
      const conn = this.connections.get(m.from);
      if (!conn) return;
      void this.handleDescription(conn, m.sdp);
    });

    this.signaling.on('ice', (m: SignalMessage) => {
      if (!m.from) return;
      const conn = this.connections.get(m.from);
      if (!conn) return;
      void this.handleCandidate(conn, m.candidate);
    });
  }

  /**
   * Create and send a single offer for one connection, guarded against
   * re-entrancy and glare: never start while an offer is already in flight or
   * the connection is mid-negotiation. This is the only place an offer originates.
   */
  private async negotiate(conn: RemoteConnection): Promise<void> {
    const { pc } = conn;
    if (conn.makingOffer || pc.signalingState !== 'stable') return;
    try {
      conn.makingOffer = true;
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.signaling.send({
          type: 'offer',
          to: conn.remoteId,
          sdp: pc.localDescription,
        });
      }
    } catch {
      /* negotiation will be retried on the next trigger */
    } finally {
      conn.makingOffer = false;
    }
  }

  private async handleDescription(
    conn: RemoteConnection,
    sdp: RTCSessionDescriptionInit | undefined,
  ): Promise<void> {
    if (!sdp) return;
    const { pc } = conn;
    const offerCollision =
      sdp.type === 'offer' && (conn.makingOffer || pc.signalingState !== 'stable');

    conn.ignoreOffer = !this.polite && offerCollision;
    if (conn.ignoreOffer) return;

    if (offerCollision) {
      // Polite peer rolls back its own offer before accepting the remote one.
      await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit);
    }

    await pc.setRemoteDescription(sdp);
    // The remote description is now applied; any candidates that arrived early
    // can be safely added. Mark and drain the queue.
    conn.remoteDescriptionSet = true;
    await this.drainPendingCandidates(conn);

    if (sdp.type === 'offer') {
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.signaling.send({
          type: 'answer',
          to: conn.remoteId,
          sdp: pc.localDescription,
        });
      }
    }
  }

  private async handleCandidate(
    conn: RemoteConnection,
    candidate: RTCIceCandidateInit | undefined,
  ): Promise<void> {
    if (!candidate) return;
    // Trickled candidates routinely arrive before this peer has applied the
    // remote description. Queue them and replay after setRemoteDescription
    // instead of letting addIceCandidate reject with InvalidStateError.
    if (!conn.remoteDescriptionSet) {
      conn.pendingCandidates.push(candidate);
      return;
    }
    await this.addCandidateSafe(conn, candidate);
  }

  /** Add a candidate, swallowing the benign failures that occur during glare. */
  private async addCandidateSafe(
    conn: RemoteConnection,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    try {
      await conn.pc.addIceCandidate(candidate);
    } catch {
      // Never re-throw: a late/duplicate candidate or one dropped during the
      // polite peer's rollback window is benign and must not surface as an
      // unhandled rejection (this is invoked via `void`).
    }
  }

  /** Replay queued early candidates now that the remote description is set. */
  private async drainPendingCandidates(conn: RemoteConnection): Promise<void> {
    if (conn.pendingCandidates.length === 0) return;
    const queued = conn.pendingCandidates.splice(0, conn.pendingCandidates.length);
    for (const c of queued) {
      await this.addCandidateSafe(conn, c);
    }
  }

  private bindInputChannel(conn: RemoteConnection, channel: RTCDataChannel): void {
    conn.inputChannel = channel;
    channel.onmessage = (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const input = decodeInput(data);
        for (const cb of this.inputHandlers) cb(input, conn.remoteId);
      } catch {
        /* drop malformed input frame */
      }
    };
  }

  private bindControlChannel(conn: RemoteConnection, channel: RTCDataChannel): void {
    conn.controlChannel = channel;
    channel.onmessage = (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const parsed: unknown = JSON.parse(data);
        if (isControlMessage(parsed)) {
          for (const cb of this.controlHandlers) cb(parsed, conn.remoteId);
        }
      } catch {
        /* drop malformed control frame */
      }
    };
  }

  private bindFileChannel(conn: RemoteConnection, channel: RTCDataChannel): void {
    conn.fileChannel = channel;
    // Binary frames come through as ArrayBuffer; ensure the channel delivers
    // them as such (not Blob) where the runtime supports the hint.
    try {
      channel.binaryType = 'arraybuffer';
    } catch {
      /* not configurable on this backend */
    }
    channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW;
    channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data as unknown;
      if (data instanceof ArrayBuffer) {
        for (const cb of this.fileChunkHandlers) cb(data, conn.remoteId);
      } else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const copy = new Uint8Array(view.byteLength);
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        for (const cb of this.fileChunkHandlers) cb(copy.buffer, conn.remoteId);
      }
      // Blob/other types are ignored — file frames are always binary ArrayBuffer.
    };
  }

  /**
   * Send a {@link ControlMessage} over the reliable, ordered `control` channel.
   * With no `to`, broadcasts to every connected remote; pass a remote id to
   * target one viewer.
   */
  sendControl(m: ControlMessage, to?: string): void {
    for (const conn of this.targetConnections(to)) {
      const ch = conn.controlChannel;
      if (ch && ch.readyState === 'open') ch.send(JSON.stringify(m));
    }
  }

  /**
   * Register a handler for inbound {@link ControlMessage}s. The second argument
   * is the originating remote id (the viewer it came from), for attribution.
   *
   * Returns a disposer that unregisters this exact handler. Callers that add a
   * short-lived, per-operation handler (e.g. a per-transfer file-accept routing
   * handler) MUST call the disposer once the operation settles so the handler —
   * and everything its closure retains — can be garbage-collected; otherwise the
   * handler set (and the captured state) grows unbounded for the session's life.
   * Existing callers may ignore the return value with no behavior change.
   */
  onControl(cb: (m: ControlMessage, remoteId: string) => void): () => void {
    this.controlHandlers.add(cb);
    return () => {
      this.controlHandlers.delete(cb);
    };
  }

  /**
   * Send one binary file chunk over the reliable, ordered `file` channel. With
   * no `to`, broadcasts to every connected remote; pass a remote id to target
   * one viewer.
   */
  sendFileChunk(buf: ArrayBuffer, to?: string): void {
    for (const conn of this.targetConnections(to)) {
      const ch = conn.fileChannel;
      if (ch && ch.readyState === 'open') ch.send(buf);
    }
  }

  /**
   * Register a handler for inbound binary file chunks. The second argument is
   * the originating remote id, for attribution.
   */
  onFileChunk(cb: (buf: ArrayBuffer, remoteId: string) => void): void {
    this.fileChunkHandlers.add(cb);
  }

  /**
   * Current buffered byte count on the `file` channel(s) (for backpressure).
   * With no `to`, returns the max buffered amount across all connections so a
   * single slow viewer still throttles a broadcast.
   */
  getFileBufferedAmount(to?: string): number {
    let max = 0;
    for (const conn of this.targetConnections(to)) {
      max = Math.max(max, conn.fileChannel?.bufferedAmount ?? 0);
    }
    return max;
  }

  /**
   * Backpressure helper for file sending: resolves immediately while every
   * targeted `file` channel buffer is below the high-water mark, otherwise waits
   * for each over-full channel's `bufferedamountlow` event (buffer drained below
   * {@link FILE_BUFFER_LOW}). Pass this as the `drain` option to `createSender`.
   * With no `to`, waits across all connections (the slowest viewer paces the
   * broadcast).
   */
  drainFile(to?: string): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const conn of this.targetConnections(to)) {
      const ch = conn.fileChannel;
      if (!ch || ch.readyState !== 'open') continue;
      if (ch.bufferedAmount < FILE_BUFFER_HIGH) continue;
      waits.push(
        new Promise<void>((resolve) => {
          const handler = (): void => {
            ch.removeEventListener('bufferedamountlow', handler);
            resolve();
          };
          ch.addEventListener('bufferedamountlow', handler);
        }),
      );
    }
    return waits.length === 0 ? Promise.resolve() : Promise.all(waits).then(() => undefined);
  }

  /**
   * Attach a local {@link MediaStream} (host screen capture, optionally with a
   * loopback/system-audio track) to send. Tracks are added to every existing
   * connection and replayed onto any connection created later (a viewer that
   * joins after this call). Each `addTrack` fires `onnegotiationneeded`, the
   * single path that produces an offer — no manual offer is forced here.
   */
  attachStream(s: MediaStream): void {
    if (!this.running) throw new Error('Peer.attachStream: call start() first');
    this.localStream = s;
    for (const conn of this.connections.values()) {
      for (const track of s.getTracks()) {
        conn.pc.addTrack(track, s);
      }
    }
  }

  /**
   * Restart ICE to recover a dead transport path (WiFi roam, brief AP loss, NIC
   * sleep) WITHOUT tearing down the peer — media tracks and data channels are
   * preserved. The host (impolite, offerer) drives this: it flags an ICE restart
   * and re-offers on each connection. Applies to every connection (or one, if
   * `remoteId` is given).
   *
   * Safe to call on either role: the viewer has no standing offer to make, so it
   * relies on the host's re-offer and on its own `addIceCandidate` resuming once
   * the new offer/answer completes. Returns false if there is no connection to
   * renegotiate with.
   */
  restartIce(remoteId?: string): boolean {
    const conns =
      remoteId !== undefined
        ? this.connections.has(remoteId)
          ? [this.connections.get(remoteId)!]
          : []
        : [...this.connections.values()];
    if (conns.length === 0) return false;
    for (const conn of conns) {
      try {
        conn.pc.restartIce();
      } catch {
        /* not supported on this backend — fall through to forced renegotiation */
      }
      // Only the impolite offerer (host) originates the re-offer. Drive it
      // directly so an established connection whose path died gets new ICE
      // credentials even though no addTrack/createDataChannel fires
      // onnegotiationneeded.
      if (this.role === 'host') void this.negotiate(conn);
    }
    return true;
  }

  /** True while at least one live `RTCPeerConnection` exists (i.e. `start()` ran and `close()` did not). */
  get isOpen(): boolean {
    return this.running;
  }

  /** Number of live remote connections (viewers, host-side). */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** The ids of the currently-connected remote peers. */
  get remoteIds(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * Replace the outbound video track in place (multi-monitor switching) without
   * a full renegotiation, across every connection (or one, if `remoteId` is
   * given). Finds each connection's video sender and swaps its track. Returns
   * true if at least one sender was updated.
   */
  async replaceVideoTrack(track: MediaStreamTrack, remoteId?: string): Promise<boolean> {
    let replaced = false;
    for (const conn of this.targetConnections(remoteId)) {
      const sender = conn.pc.getSenders().find((sn) => sn.track?.kind === 'video');
      if (!sender) continue;
      await sender.replaceTrack(track);
      replaced = true;
    }
    // Keep the attached stream record in sync so future connections replay it.
    if (replaced && this.localStream) {
      for (const t of this.localStream.getVideoTracks()) {
        if (t !== track) {
          this.localStream.removeTrack(t);
        }
      }
      if (!this.localStream.getVideoTracks().includes(track)) {
        this.localStream.addTrack(track);
      }
    }
    return replaced;
  }

  /** Whether an audio track is currently attached to an outbound sender. */
  getAudioTrackPresent(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.pc.getSenders().some((s) => s.track?.kind === 'audio')) return true;
    }
    return false;
  }

  /**
   * Send an {@link InputEvent} to the remote peer over the data channel. With no
   * `to`, sends to every connection (a viewer-side peer has exactly one); pass a
   * remote id to target one peer.
   */
  sendInput(e: InputEvent, to?: string): void {
    const encoded = encodeInput(e);
    for (const conn of this.targetConnections(to)) {
      const ch = conn.inputChannel;
      if (ch && ch.readyState === 'open') ch.send(encoded);
    }
  }

  /**
   * Register a handler for inbound {@link InputEvent}s (host side). The second
   * argument is the originating remote id, so the host can attribute / arbitrate
   * input from multiple controllers instead of colliding them on one channel.
   */
  onInput(cb: (e: InputEvent, remoteId: string) => void): void {
    this.inputHandlers.add(cb);
  }

  /**
   * Resolve the connections a fan-out operation targets: one (when `to` names a
   * known remote) or all. An unknown `to` resolves to none.
   */
  private targetConnections(to?: string): Iterable<RemoteConnection> {
    if (to === undefined) return this.connections.values();
    const conn = this.connections.get(to);
    return conn ? [conn] : [];
  }

  /**
   * Gather a fresh {@link AdaptiveStats} snapshot. With no `remoteId`, aggregates
   * across all connections to the WORST observed value per metric (max rtt, loss,
   * jitter; min available bitrate; min fps; representative resolution) so the
   * adaptive engine backs off for the most-constrained viewer. Pass a remote id
   * to scope the snapshot to a single connection.
   *
   * Derived from the WebRTC stats report:
   *  - `rttMs` from the active candidate-pair RTT,
   *  - `lossPct` / `jitterMs` from inbound/outbound RTP,
   *  - `fps` and frame `width`/`height` from the active video track,
   *  - `availableKbps` from `available-outgoing-bitrate`.
   */
  async getStats(remoteId?: string): Promise<AdaptiveStats> {
    const conns = [...this.targetConnections(remoteId)];
    const ts = Date.now();
    if (conns.length === 0) {
      return {
        rttMs: 0,
        lossPct: 0,
        jitterMs: 0,
        availableKbps: 0,
        fps: 0,
        width: 0,
        height: 0,
        playoutMs: 0,
        ts,
      };
    }

    const perConn = await Promise.all(conns.map((c) => this.statsFor(c)));
    const agg = this.aggregateStats(perConn);
    agg.ts = ts;
    this.emit('stats', agg);
    return agg;
  }

  /**
   * Compact receive-side interactive-latency telemetry for the viewer to report
   * back to the host over the `control` channel ({@link ControlMessage} variant
   * `latency`). The viewer is the side with inbound video, so this is where the
   * real end-to-end latency (network RTT + playout/jitter-buffer delay) is
   * observed. The host folds the reported `playoutMs` into its
   * {@link AdaptiveController} so receiver-side queueing forces real-time backoff.
   *
   * Returns `{ rttMs, playoutMs, fps }` derived from {@link getStats} (worst-case
   * across connections when `remoteId` is omitted). All fields are 0 when no
   * inbound media is flowing yet.
   */
  async getLocalTelemetry(remoteId?: string): Promise<{ rttMs: number; playoutMs: number; fps: number }> {
    const s = await this.getStats(remoteId);
    return { rttMs: s.rttMs, playoutMs: s.playoutMs ?? 0, fps: s.fps };
  }

  /** Combine per-connection snapshots into the worst-case view across viewers. */
  private aggregateStats(snapshots: AdaptiveStats[]): AdaptiveStats {
    if (snapshots.length === 1) return snapshots[0];
    const agg: AdaptiveStats = {
      rttMs: 0,
      lossPct: 0,
      jitterMs: 0,
      availableKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
      playoutMs: 0,
      ts: 0,
    };
    let availSet = false;
    let fpsSet = false;
    for (const s of snapshots) {
      agg.rttMs = Math.max(agg.rttMs, s.rttMs);
      agg.lossPct = Math.max(agg.lossPct, s.lossPct);
      agg.jitterMs = Math.max(agg.jitterMs, s.jitterMs);
      // Worst-case playout: the most-buffered viewer drives end-to-end latency.
      agg.playoutMs = Math.max(agg.playoutMs ?? 0, s.playoutMs ?? 0);
      if (s.availableKbps > 0) {
        agg.availableKbps = availSet
          ? Math.min(agg.availableKbps, s.availableKbps)
          : s.availableKbps;
        availSet = true;
      }
      if (s.fps > 0) {
        agg.fps = fpsSet ? Math.min(agg.fps, s.fps) : s.fps;
        fpsSet = true;
      }
      // Resolution is the same source frame for every viewer; take any non-zero.
      if (s.width > 0) agg.width = s.width;
      if (s.height > 0) agg.height = s.height;
    }
    return agg;
  }

  /** Build an {@link AdaptiveStats} snapshot for a single connection. */
  private async statsFor(conn: RemoteConnection): Promise<AdaptiveStats> {
    const snapshot: AdaptiveStats = {
      rttMs: 0,
      lossPct: 0,
      jitterMs: 0,
      availableKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
      playoutMs: 0,
      ts: Date.now(),
    };

    const report = await conn.pc.getStats();
    let packetsLost = 0;
    let packetsTotal = 0;

    // Accumulate jitter-buffer samples across all inbound video streams this
    // tick, then convert to a delta-based average against the previous tick.
    let curDelay = 0;
    let curCount = 0;
    let prevDelay = 0;
    let prevCount = 0;
    const prevForConn = this.jitterBufferPrev.get(conn.remoteId);

    report.forEach((stat: { [k: string]: unknown; type?: string }) => {
      switch (stat.type) {
        case 'candidate-pair': {
          if (stat.nominated || stat.state === 'succeeded') {
            const rtt = numOf(stat.currentRoundTripTime);
            if (rtt > 0) snapshot.rttMs = rtt * 1000;
            const avail = numOf(stat.availableOutgoingBitrate);
            if (avail > 0) snapshot.availableKbps = avail / 1000;
          }
          break;
        }
        case 'inbound-rtp': {
          if (stat.kind === 'video') {
            snapshot.jitterMs = Math.max(snapshot.jitterMs, numOf(stat.jitter) * 1000);
            const lost = numOf(stat.packetsLost);
            const recv = numOf(stat.packetsReceived);
            packetsLost += lost;
            packetsTotal += lost + recv;
            const fps = numOf(stat.framesPerSecond);
            if (fps > 0) snapshot.fps = fps;
            const w = numOf(stat.frameWidth);
            const h = numOf(stat.frameHeight);
            if (w > 0) snapshot.width = w;
            if (h > 0) snapshot.height = h;
            // Receiver playout delay (seconds, cumulative): average delay per
            // emitted frame is jitterBufferDelay / jitterBufferEmittedCount.
            // Accumulate raw cumulative totals; convert to a per-window average
            // (in ms) after the report is fully scanned, using the prior tick.
            const jbDelay = numOf(stat.jitterBufferDelay);
            const jbCount = numOf(stat.jitterBufferEmittedCount);
            if (jbCount > 0) {
              const key = String(stat.id ?? stat.ssrc ?? 'inbound-video');
              curDelay += jbDelay;
              curCount += jbCount;
              const prior = prevForConn?.get(key);
              if (prior) {
                prevDelay += prior.delay;
                prevCount += prior.count;
              }
              this.recordJitterBufferSample(conn.remoteId, key, jbDelay, jbCount);
            }
          }
          break;
        }
        case 'outbound-rtp': {
          if (stat.kind === 'video') {
            const fps = numOf(stat.framesPerSecond);
            if (fps > 0 && snapshot.fps === 0) snapshot.fps = fps;
            const w = numOf(stat.frameWidth);
            const h = numOf(stat.frameHeight);
            if (w > 0 && snapshot.width === 0) snapshot.width = w;
            if (h > 0 && snapshot.height === 0) snapshot.height = h;
          }
          break;
        }
        case 'remote-inbound-rtp': {
          // Sender-side view of loss/jitter reported by the remote.
          const jitter = numOf(stat.jitter) * 1000;
          if (jitter > 0) snapshot.jitterMs = Math.max(snapshot.jitterMs, jitter);
          const lost = numOf(stat.packetsLost);
          if (lost > 0) packetsLost += lost;
          const frac = numOf(stat.fractionLost);
          if (frac > 0 && snapshot.lossPct === 0) snapshot.lossPct = frac * 100;
          break;
        }
        default:
          break;
      }
    });

    if (packetsTotal > 0) {
      snapshot.lossPct = Math.max(snapshot.lossPct, (packetsLost / packetsTotal) * 100);
    }

    // Delta-based average playout delay over just the last window: prefer the
    // change in cumulative delay/count between ticks (steady-state queueing);
    // fall back to the lifetime average on the very first tick (no prior).
    const dCount = curCount - prevCount;
    const dDelay = curDelay - prevDelay;
    if (dCount > 0) {
      snapshot.playoutMs = (dDelay / dCount) * 1000;
    } else if (curCount > 0) {
      snapshot.playoutMs = (curDelay / curCount) * 1000;
    } else {
      snapshot.playoutMs = 0;
    }
    if (!(snapshot.playoutMs > 0)) snapshot.playoutMs = 0;

    return snapshot;
  }

  /** Stash this tick's cumulative jitter-buffer sample for next tick's delta. */
  private recordJitterBufferSample(
    remoteId: string,
    key: string,
    delay: number,
    count: number,
  ): void {
    let perConn = this.jitterBufferPrev.get(remoteId);
    if (!perConn) {
      perConn = new Map();
      this.jitterBufferPrev.set(remoteId, perConn);
    }
    perConn.set(key, { delay, count });
  }

  /**
   * Apply an {@link AdaptiveDecision} by updating each outbound video sender's
   * first encoding's `maxBitrate`, `maxFramerate`, and `scaleResolutionDownBy`.
   * Fans out to every connection (or one, if `remoteId` is given) so all viewers
   * track the decision.
   */
  async applyDecision(d: AdaptiveDecision, remoteId?: string): Promise<void> {
    await Promise.all(
      [...this.targetConnections(remoteId)].map((conn) => this.applyDecisionTo(conn, d)),
    );
  }

  private async applyDecisionTo(conn: RemoteConnection, d: AdaptiveDecision): Promise<void> {
    const sender = conn.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    // Drop framerate before resolution under load: a remote desktop must keep
    // text readable, so never let the encoder scale the picture down on a busy
    // screen. (Default 'balanced' would reduce resolution and blur text.)
    params.degradationPreference = 'maintain-resolution';
    const enc = params.encodings[0];
    enc.maxBitrate = Math.round(d.targetKbps * 1000);
    enc.maxFramerate = d.maxFramerate;
    enc.scaleResolutionDownBy = d.scaleResolutionDownBy;
    await sender.setParameters(params);
  }

  /** Close and unwire a single connection's channels + peer connection. */
  private closeConnection(conn: RemoteConnection): void {
    for (const ch of [conn.inputChannel, conn.controlChannel, conn.fileChannel]) {
      if (ch) {
        try {
          ch.close();
        } catch {
          /* ignore */
        }
      }
    }
    conn.inputChannel = null;
    conn.controlChannel = null;
    conn.fileChannel = null;
    this.jitterBufferPrev.delete(conn.remoteId);
    try {
      conn.pc.close();
    } catch {
      /* ignore */
    }
  }

  /** Tear down all connections and channels. No-op if already closed. */
  close(): void {
    for (const conn of this.connections.values()) {
      this.closeConnection(conn);
    }
    this.connections.clear();
    this.jitterBufferPrev.clear();
    this.localStream = null;
    this.running = false;
    this.inputHandlers.clear();
    this.controlHandlers.clear();
    this.fileChunkHandlers.clear();
  }
}

/** Coerce an unknown stats field to a finite number (0 otherwise). */
function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
