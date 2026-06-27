import type { Role, SignalMessage } from './protocol.js';

/** Callback invoked for each inbound signaling message of a subscribed type. */
export type SignalHandler = (m: SignalMessage) => void;

/**
 * The minimal WebSocket surface this client relies on. Both the browser's
 * global `WebSocket` and the node `ws` package satisfy it, so the same code
 * path drives either implementation.
 */
interface MinimalWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

type WebSocketCtor = new (url: string) => MinimalWebSocket;

const OPEN = 1;

/** Reconnect backoff schedule (ms), capped at the last value. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * Resolve a `WebSocket` constructor that works in the current runtime.
 *
 * In a browser (or any runtime with a global `WebSocket`, including modern
 * node ≥ 21) we use the global. Otherwise we lazily `import('ws')` so this
 * module never hard-depends on a node-only package and still bundles cleanly
 * for the browser.
 */
async function resolveWebSocket(): Promise<WebSocketCtor> {
  const g = globalThis as unknown as { WebSocket?: WebSocketCtor };
  if (typeof g.WebSocket === 'function') {
    return g.WebSocket;
  }
  const mod = (await import('ws')) as unknown as {
    default?: WebSocketCtor;
    WebSocket?: WebSocketCtor;
  };
  const ctor = mod.WebSocket ?? mod.default;
  if (typeof ctor !== 'function') {
    throw new Error('SignalingClient: could not resolve a WebSocket implementation');
  }
  return ctor;
}

/**
 * WebSocket client for the StreamScreen signaling server.
 *
 * Responsible only for connection bootstrap: joining a room, relaying SDP/ICE
 * between peers, and listing LAN hosts. It carries no media or input traffic —
 * that flows peer-to-peer once the {@link Peer} negotiation completes.
 *
 * Incoming messages are dispatched to handlers keyed by {@link SignalMessage.type}.
 * If the socket drops it reconnects with exponential backoff and replays the
 * last `join` so a peer transparently rejoins its room.
 */
export class SignalingClient {
  private readonly url: string;
  private ws: MinimalWebSocket | null = null;
  private readonly handlers = new Map<string, Set<SignalHandler>>();
  private lastJoin: SignalMessage | null = null;
  private outbox: string[] = [];
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingPromise: Promise<void> | null = null;

  /**
   * @param url WebSocket URL of the signaling server, e.g. `ws://192.168.1.5:8787`.
   */
  constructor(url: string) {
    this.url = url;
  }

  /** Open the WebSocket and resolve once it is ready to send. */
  async connect(): Promise<void> {
    this.closedByUser = false;
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = this.openSocket();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    const Ctor = await resolveWebSocket();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new Ctor(this.url);
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempt = 0;
        // The server drops any relayable frame (offer/answer/ice) from a peer
        // that has not yet joined a room. On a reconnect the socket is a brand
        // new, unjoined peer, so the remembered join MUST be the first frame on
        // the wire — ahead of any offer/ice queued during the outage. Prepend it
        // before draining the outbox.
        const pending = this.outbox;
        this.outbox = [];
        const frames = this.lastJoin ? [JSON.stringify(this.lastJoin), ...pending] : pending;
        for (const raw of frames) {
          try {
            ws.send(raw);
          } catch {
            this.outbox.push(raw);
          }
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = (ev) => {
        this.dispatch(ev.data);
      };

      ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error('SignalingClient: socket error'));
        }
      };

      ws.onclose = () => {
        this.ws = null;
        if (!this.closedByUser) {
          this.scheduleReconnect();
        }
        if (!settled) {
          settled = true;
          reject(new Error('SignalingClient: socket closed before opening'));
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // openSocket()'s onopen re-announces presence by sending lastJoin as the
      // first frame, so no explicit rejoin is needed here.
      void this.openSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private dispatch(data: unknown): void {
    let msg: SignalMessage;
    try {
      const text = typeof data === 'string' ? data : String(data);
      msg = JSON.parse(text) as SignalMessage;
    } catch {
      return; // ignore non-JSON frames
    }
    if (!msg || typeof msg.type !== 'string') return;
    const set = this.handlers.get(msg.type);
    if (set) for (const cb of set) cb(msg);
    const wildcard = this.handlers.get('*');
    if (wildcard) for (const cb of wildcard) cb(msg);
  }

  /**
   * Join (or create) a room. A host advertises a session under `code`;
   * a viewer joins an existing one. The join is remembered and replayed on
   * reconnect.
   */
  join(p: { room?: string; code?: string; role: Role; name?: string }): void {
    const msg: SignalMessage = {
      type: 'join',
      room: p.room,
      code: p.code,
      role: p.role,
      name: p.name,
      ts: Date.now(),
    };
    this.lastJoin = msg;
    this.send(msg);
  }

  /** Send a raw signaling message to the server (queued if offline). */
  send(m: SignalMessage): void {
    const raw = JSON.stringify(m);
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) {
      try {
        ws.send(raw);
        return;
      } catch {
        // fall through to queue
      }
    }
    this.outbox.push(raw);
  }

  /** Subscribe to inbound messages of a given {@link SignalMessage.type} (or `'*'`). */
  on(type: string, cb: SignalHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb);
  }

  /** Unsubscribe a handler previously registered with {@link on}. */
  off(type: string, cb: SignalHandler): void {
    this.handlers.get(type)?.delete(cb);
  }

  /** Close the underlying WebSocket and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
  }
}
