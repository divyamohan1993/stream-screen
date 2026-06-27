import type { AdaptiveDecision, AdaptiveStats, InputEvent, Role } from './protocol.js';
import type { SignalingClient } from './signaling-client.js';

/** Events emitted by a {@link Peer}. */
export type PeerEvent = 'track' | 'datachannel' | 'state' | 'stats';

/** Options for constructing a {@link Peer}. */
export interface PeerOptions {
  role: Role;
  signaling: SignalingClient;
  iceServers?: RTCIceServer[];
}

/**
 * WebRTC peer wrapper around `RTCPeerConnection`.
 *
 * Drives offer/answer negotiation through a {@link SignalingClient}, carries
 * screen video (host -> viewer) and an input data channel (viewer -> host),
 * surfaces live {@link AdaptiveStats}, and applies {@link AdaptiveDecision}s to
 * the outbound video sender's encoding parameters.
 *
 * Media and DTLS-SRTP encryption are handled by the browser/node WebRTC stack;
 * there are no session time limits or bitrate caps imposed here.
 *
 * NOTE: stub — full implementation lands in the core implementation phase.
 */
export class Peer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(opts: PeerOptions) {
    void opts;
  }

  /** Subscribe to a peer lifecycle/data event. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  on(ev: PeerEvent, cb: Function): void {
    void ev;
    void cb;
    throw new Error('not-implemented');
  }

  /** Begin negotiation (create the connection, channels, and offer/answer). */
  async start(): Promise<void> {
    throw new Error('not-implemented');
  }

  /** Attach a local {@link MediaStream} (host screen capture) to send. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  attachStream(s: MediaStream): void {
    void s;
    throw new Error('not-implemented');
  }

  /** Send an {@link InputEvent} to the remote peer over the data channel. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendInput(e: InputEvent): void {
    void e;
    throw new Error('not-implemented');
  }

  /** Register a handler for inbound {@link InputEvent}s (host side). */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onInput(cb: (e: InputEvent) => void): void {
    void cb;
    throw new Error('not-implemented');
  }

  /** Gather a fresh {@link AdaptiveStats} snapshot from the connection. */
  async getStats(): Promise<AdaptiveStats> {
    throw new Error('not-implemented');
  }

  /** Apply an {@link AdaptiveDecision} to the outbound video sender. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async applyDecision(d: AdaptiveDecision): Promise<void> {
    void d;
    throw new Error('not-implemented');
  }

  /** Tear down the connection and all channels. */
  close(): void {
    throw new Error('not-implemented');
  }
}
