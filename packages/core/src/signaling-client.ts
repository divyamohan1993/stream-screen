import type { Role, SignalMessage } from './protocol.js';

/** Callback invoked for each inbound signaling message of a subscribed type. */
export type SignalHandler = (m: SignalMessage) => void;

/**
 * Thin WebSocket client for the StreamScreen signaling server.
 *
 * Responsible only for connection bootstrap: joining a room, relaying
 * SDP/ICE between peers, and listing LAN hosts. It carries no media or input
 * traffic — that flows peer-to-peer once the {@link Peer} negotiation completes.
 *
 * NOTE: stub — full implementation lands in the core implementation phase.
 */
export class SignalingClient {
  /**
   * @param url WebSocket URL of the signaling server, e.g. `ws://192.168.1.5:8787`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(url: string) {
    void url;
  }

  /** Open the WebSocket and resolve once it is ready to send. */
  async connect(): Promise<void> {
    throw new Error('not-implemented');
  }

  /**
   * Join (or create) a room. A host advertises a session under `code`;
   * a viewer joins an existing one.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  join(p: { room?: string; code?: string; role: Role; name?: string }): void {
    void p;
    throw new Error('not-implemented');
  }

  /** Send a raw signaling message to the server. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  send(m: SignalMessage): void {
    void m;
    throw new Error('not-implemented');
  }

  /** Subscribe to inbound messages of a given {@link SignalMessage.type}. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  on(type: string, cb: SignalHandler): void {
    void type;
    void cb;
    throw new Error('not-implemented');
  }

  /** Close the underlying WebSocket. */
  close(): void {
    throw new Error('not-implemented');
  }
}
