import type { AdaptiveDecision, AdaptiveStats, InputEvent, Role, SignalMessage } from './protocol.js';
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
 * WebRTC peer wrapper around `RTCPeerConnection`.
 *
 * Drives offer/answer negotiation through a {@link SignalingClient} using the
 * perfect-negotiation pattern (the host is impolite and always wins glare; the
 * viewer is polite and rolls back). The host creates the offer once a viewer
 * joins; the viewer answers. ICE candidates are trickled over signaling.
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

  private pc: RTCPeerConnection | null = null;
  private inputChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;

  private readonly listeners = new Map<PeerEvent, Set<AnyCb>>();
  private readonly inputHandlers = new Set<(e: InputEvent) => void>();

  // Perfect-negotiation bookkeeping.
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  /** Remote peer id we are connected to (set on first signaling exchange). */
  private remoteId: string | null = null;
  private peerJoinedSeen = false;

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
   * Begin negotiation: create the peer connection, wire signaling and ICE
   * trickle, set up the input data channel, and (host) offer when a viewer
   * joins.
   */
  async start(): Promise<void> {
    const pc = new this.RTC({ iceServers: this.iceServers });
    this.pc = pc;

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        this.signaling.send({
          type: 'ice',
          to: this.remoteId ?? undefined,
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (ev: RTCTrackEvent) => {
      this.emit('track', ev.track, ev.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      this.emit('state', pc.connectionState);
    };

    pc.ondatachannel = (ev: RTCDataChannelEvent) => {
      if (ev.channel.label === INPUT_CHANNEL) {
        this.bindInputChannel(ev.channel);
      }
      this.emit('datachannel', ev.channel);
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.signaling.send({
            type: 'offer',
            to: this.remoteId ?? undefined,
            sdp: pc.localDescription,
          });
        }
      } catch {
        /* negotiation will be retried on next trigger */
      } finally {
        this.makingOffer = false;
      }
    };

    // Host owns the input channel creation so the viewer receives it via
    // ondatachannel; both sides end up with a bound channel.
    if (this.role === 'host') {
      this.bindInputChannel(pc.createDataChannel(INPUT_CHANNEL, { ordered: true }));
    }

    this.wireSignaling(pc);
  }

  private wireSignaling(pc: RTCPeerConnection): void {
    this.signaling.on('peer-joined', (m: SignalMessage) => {
      if (m.from) this.remoteId = m.from;
      this.peerJoinedSeen = true;
      // The host kicks off negotiation by attaching its stream (which fires
      // negotiationneeded). If a stream is already attached, force an offer.
      if (this.role === 'host' && this.localStream) {
        void this.forceOffer(pc);
      }
    });

    this.signaling.on('peer-left', () => {
      this.remoteId = null;
      this.peerJoinedSeen = false;
    });

    this.signaling.on('offer', (m: SignalMessage) => {
      if (m.from) this.remoteId = m.from;
      void this.handleDescription(pc, m.sdp);
    });

    this.signaling.on('answer', (m: SignalMessage) => {
      if (m.from) this.remoteId = m.from;
      void this.handleDescription(pc, m.sdp);
    });

    this.signaling.on('ice', (m: SignalMessage) => {
      void this.handleCandidate(pc, m.candidate);
    });
  }

  private async forceOffer(pc: RTCPeerConnection): Promise<void> {
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({ type: 'offer', to: this.remoteId ?? undefined, sdp: pc.localDescription! });
    } catch {
      /* retried on next negotiationneeded */
    } finally {
      this.makingOffer = false;
    }
  }

  private async handleDescription(
    pc: RTCPeerConnection,
    sdp: RTCSessionDescriptionInit | undefined,
  ): Promise<void> {
    if (!sdp) return;
    const offerCollision =
      sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    if (offerCollision) {
      // Polite peer rolls back its own offer before accepting the remote one.
      await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit);
    }

    await pc.setRemoteDescription(sdp);
    if (sdp.type === 'offer') {
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.signaling.send({
          type: 'answer',
          to: this.remoteId ?? undefined,
          sdp: pc.localDescription,
        });
      }
    }
  }

  private async handleCandidate(
    pc: RTCPeerConnection,
    candidate: RTCIceCandidateInit | undefined,
  ): Promise<void> {
    if (!candidate) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer) throw err;
    }
  }

  private bindInputChannel(channel: RTCDataChannel): void {
    this.inputChannel = channel;
    channel.onmessage = (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const input = decodeInput(data);
        for (const cb of this.inputHandlers) cb(input);
      } catch {
        /* drop malformed input frame */
      }
    };
  }

  /** Attach a local {@link MediaStream} (host screen capture) to send. */
  attachStream(s: MediaStream): void {
    if (!this.pc) throw new Error('Peer.attachStream: call start() first');
    this.localStream = s;
    for (const track of s.getTracks()) {
      this.pc.addTrack(track, s);
    }
    // If a viewer is already present, trigger negotiation immediately.
    if (this.role === 'host' && this.peerJoinedSeen) {
      void this.forceOffer(this.pc);
    }
  }

  /** Send an {@link InputEvent} to the remote peer over the data channel. */
  sendInput(e: InputEvent): void {
    const ch = this.inputChannel;
    if (ch && ch.readyState === 'open') {
      ch.send(encodeInput(e));
    }
  }

  /** Register a handler for inbound {@link InputEvent}s (host side). */
  onInput(cb: (e: InputEvent) => void): void {
    this.inputHandlers.add(cb);
  }

  /**
   * Gather a fresh {@link AdaptiveStats} snapshot from the connection, derived
   * from the WebRTC stats report:
   *  - `rttMs` from the active candidate-pair RTT,
   *  - `lossPct` / `jitterMs` from inbound/outbound RTP,
   *  - `fps` and frame `width`/`height` from the active video track,
   *  - `availableKbps` from `available-outgoing-bitrate`.
   */
  async getStats(): Promise<AdaptiveStats> {
    const snapshot: AdaptiveStats = {
      rttMs: 0,
      lossPct: 0,
      jitterMs: 0,
      availableKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
      ts: Date.now(),
    };
    if (!this.pc) return snapshot;

    const report = await this.pc.getStats();
    let packetsLost = 0;
    let packetsTotal = 0;

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

    this.emit('stats', snapshot);
    return snapshot;
  }

  /**
   * Apply an {@link AdaptiveDecision} to the outbound video sender by updating
   * its first encoding's `maxBitrate`, `maxFramerate`, and
   * `scaleResolutionDownBy`.
   */
  async applyDecision(d: AdaptiveDecision): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0];
    enc.maxBitrate = Math.round(d.targetKbps * 1000);
    enc.maxFramerate = d.maxFramerate;
    enc.scaleResolutionDownBy = d.scaleResolutionDownBy;
    await sender.setParameters(params);
  }

  /** Tear down the connection and all channels. No-op if already closed. */
  close(): void {
    if (this.inputChannel) {
      try {
        this.inputChannel.close();
      } catch {
        /* ignore */
      }
      this.inputChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.localStream = null;
    this.inputHandlers.clear();
  }
}

/** Coerce an unknown stats field to a finite number (0 otherwise). */
function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
