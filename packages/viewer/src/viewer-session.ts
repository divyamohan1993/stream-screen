import {
  Peer,
  SignalingClient,
  isValidSessionCode,
  type AdaptiveStats,
  type InputEvent,
  type SignalMessage,
} from '@stream-screen/core';

/** Connection lifecycle states surfaced to the UI. */
export type SessionState =
  | 'idle'
  | 'connecting'
  | 'waiting-for-host'
  | 'connected'
  | 'disconnected'
  | 'error';

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
  /** Handlers for session events. */
  handlers?: ViewerSessionHandlers;
}

const DEFAULT_STATS_INTERVAL_MS = 1000;

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

  constructor(opts: ViewerSessionOptions) {
    this.opts = opts;
    this.handlers = opts.handlers ?? {};
  }

  /** Current lifecycle state. */
  get currentState(): SessionState {
    return this.state;
  }

  private setState(state: SessionState, detail?: string): void {
    this.state = state;
    this.handlers.onState?.(state, detail);
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

    signaling.on('error', (m: SignalMessage) => {
      this.setState('error', m.message ?? 'Signaling error');
    });
    signaling.on('peer-left', () => {
      if (!this.closed) this.setState('waiting-for-host', 'Host left the session.');
    });

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
      switch (connState) {
        case 'connected':
          this.setState('connected');
          break;
        case 'disconnected':
          if (!this.closed) this.setState('waiting-for-host', 'Connection interrupted.');
          break;
        case 'failed':
          this.setState('error', 'WebRTC connection failed.');
          break;
        case 'closed':
          if (!this.closed) this.setState('disconnected');
          break;
        default:
          break;
      }
    });

    // Input data channel inbound frames: only clipboard is meaningful viewer-side.
    peer.onInput((e: InputEvent) => {
      if (e.t === 'clipboard') this.handlers.onClipboard?.(e.text);
    });

    try {
      await signaling.connect();
      await peer.start();
      signaling.join({ code: this.opts.code, role: 'viewer', name: this.opts.name ?? 'web-viewer' });
      this.setState('waiting-for-host', 'Joined — waiting for host stream.');
      this.startStatsLoop();
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : 'Failed to connect');
      throw err;
    }
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
    } catch {
      /* transient stats error — ignore this tick */
    }
  }

  /** Send an input event to the host (no-op if the channel is not open). */
  sendInput(e: InputEvent): void {
    this.peer?.sendInput(e);
  }

  /** The current remote stream, if one has arrived. */
  get remoteStream(): MediaStream | null {
    return this.stream;
  }

  /** Tear down the session: stop stats, close peer + signaling. Idempotent. */
  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.signaling = null;
    this.stream = null;
    this.setState('disconnected');
  }
}
