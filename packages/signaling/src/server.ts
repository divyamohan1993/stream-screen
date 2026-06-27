/**
 * StreamScreen WebSocket signaling server.
 *
 * Responsibilities (and ONLY these):
 *   - Group peers into rooms keyed by a short numeric session code.
 *   - Relay SDP `offer`/`answer` and `ice` candidates between the single host
 *     and the viewers in a room. Once the WebRTC peer connection is up, all
 *     real traffic (video + input) flows directly peer-to-peer and never
 *     touches this server again.
 *   - Emit lifecycle events: `joined`, `peer-joined`, `peer-left`.
 *   - Keepalive via `ping`/`pong`.
 *   - Mint a session code when a host joins without one.
 *
 * UNLIMITED-USE GUARANTEE: there are deliberately NO session timers, no idle
 * disconnects, no usage counters, no licensing checks, and no bitrate caps in
 * this server. A session lives exactly as long as its sockets stay open. The
 * only timer in this file is the WebSocket keepalive heartbeat, which detects
 * *dead* sockets — it never ends a *healthy* session. This is intentional and
 * load-bearing for StreamScreen's "always free, unlimited time" promise.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Role, SignalMessage, SessionInfo } from '@stream-screen/core';
import { isSignalMessage } from '@stream-screen/core';

/** A connected peer (one WebSocket). */
interface Peer {
  id: string;
  role: Role;
  name: string;
  socket: WebSocket;
  room: string;
  /** Heartbeat liveness flag, reset on every pong. */
  alive: boolean;
}

/** Server-side room state. One host + N viewers per session code. */
interface Room {
  code: string;
  hostName: string;
  createdAt: number;
  peers: Map<string, Peer>;
}

export interface SignalingServerOptions {
  /** Attach to an existing HTTP server (so REST + WS share one port). */
  server?: HttpServer;
  /** Or bind the WS server directly to this port. */
  port?: number;
  /**
   * Heartbeat interval in ms used to detect dead sockets. This NEVER ends a
   * healthy session — it only reaps sockets that stopped answering pongs.
   * Set to 0 to disable entirely.
   */
  heartbeatMs?: number;
  /** Number of digits for generated session codes (6..9). */
  codeDigits?: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CODE_DIGITS = 6;

/**
 * Generate a numeric session code with the requested number of digits.
 * The first digit is always 1..9 so the code never has a leading zero and
 * always renders as exactly `digits` characters.
 */
export function generateCode(digits = DEFAULT_CODE_DIGITS): string {
  const d = Math.min(9, Math.max(6, Math.floor(digits)));
  let code = String(1 + Math.floor(Math.random() * 9));
  for (let i = 1; i < d; i++) {
    code += String(Math.floor(Math.random() * 10));
  }
  return code;
}

export class SignalingServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly heartbeatMs: number;
  private readonly codeDigits: number;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(opts: SignalingServerOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.codeDigits = opts.codeDigits ?? DEFAULT_CODE_DIGITS;

    if (opts.server) {
      this.wss = new WebSocketServer({ server: opts.server });
    } else {
      this.wss = new WebSocketServer({ port: opts.port ?? 0 });
    }

    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
    this.startHeartbeat();
  }

  /** The bound port (useful when constructed with `port: 0`). */
  get port(): number {
    const addr = this.wss.address();
    if (addr && typeof addr === 'object') return addr.port;
    return 0;
  }

  /** Snapshot of all active sessions, for the REST `/api/sessions` endpoint. */
  listSessions(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const room of this.rooms.values()) {
      out.push({
        code: room.code,
        hostName: room.hostName,
        createdAt: room.createdAt,
        viewers: this.countViewers(room),
      });
    }
    return out;
  }

  /** Mint a fresh, currently-unused session code. */
  mintCode(): string {
    let code = generateCode(this.codeDigits);
    // Vanishingly unlikely to collide, but guarantee uniqueness anyway.
    while (this.rooms.has(code)) code = generateCode(this.codeDigits);
    return code;
  }

  private countViewers(room: Room): number {
    let n = 0;
    for (const p of room.peers.values()) if (p.role === 'viewer') n++;
    return n;
  }

  private onConnection(socket: WebSocket, _req: IncomingMessage): void {
    // Peer is unregistered until it sends a valid `join`.
    let peer: Peer | undefined;

    socket.on('message', (data: RawData) => {
      const msg = parseMessage(data);
      if (!msg) {
        this.sendError(socket, 'invalid-json');
        return;
      }

      switch (msg.type) {
        case 'join': {
          if (peer) {
            this.sendError(socket, 'already-joined');
            return;
          }
          peer = this.handleJoin(socket, msg);
          return;
        }
        case 'ping': {
          this.send(socket, { type: 'pong', ts: Date.now() });
          return;
        }
        case 'pong': {
          if (peer) peer.alive = true;
          return;
        }
        case 'offer':
        case 'answer':
        case 'ice': {
          if (!peer) {
            this.sendError(socket, 'not-joined');
            return;
          }
          this.relay(peer, msg);
          return;
        }
        default: {
          // Unknown / non-relayable type from a client; ignore safely.
          return;
        }
      }
    });

    socket.on('pong', () => {
      if (peer) peer.alive = true;
    });

    socket.on('close', () => {
      if (peer) this.handleLeave(peer);
    });

    socket.on('error', () => {
      if (peer) this.handleLeave(peer);
    });
  }

  private handleJoin(socket: WebSocket, msg: SignalMessage): Peer | undefined {
    const role: Role = msg.role === 'host' ? 'host' : 'viewer';
    const name = (msg.name ?? '').trim() || (role === 'host' ? 'host' : 'viewer');

    let code = (msg.code ?? msg.room ?? '').trim();

    if (role === 'host') {
      // A host without a code starts a brand-new session; mint one.
      if (!code) code = this.mintCode();
    } else {
      // Viewers must target an existing room.
      if (!code) {
        this.sendError(socket, 'missing-code');
        return undefined;
      }
      if (!this.rooms.has(code)) {
        this.sendError(socket, 'no-such-session');
        return undefined;
      }
    }

    let room = this.rooms.get(code);
    if (!room) {
      room = { code, hostName: name, createdAt: Date.now(), peers: new Map() };
      this.rooms.set(code, room);
    } else if (role === 'host') {
      // A (re)joining host refreshes the advertised host name.
      room.hostName = name;
    }

    const peer: Peer = {
      id: randomUUID(),
      role,
      name,
      socket,
      room: code,
      alive: true,
    };
    room.peers.set(peer.id, peer);

    // Acknowledge the joiner with its identity + the resolved code.
    this.send(socket, {
      type: 'joined',
      from: peer.id,
      code,
      room: code,
      role,
      name,
      ts: Date.now(),
    });

    // Notify existing peers that someone arrived, and tell the joiner who is
    // already present so a viewer immediately knows the host id to offer to.
    for (const other of room.peers.values()) {
      if (other.id === peer.id) continue;
      this.send(other.socket, {
        type: 'peer-joined',
        from: peer.id,
        room: code,
        code,
        role: peer.role,
        name: peer.name,
        ts: Date.now(),
      });
      this.send(socket, {
        type: 'peer-joined',
        from: other.id,
        room: code,
        code,
        role: other.role,
        name: other.name,
        ts: Date.now(),
      });
    }

    return peer;
  }

  /**
   * Relay an offer/answer/ice message to its target. If `to` is set, deliver
   * only to that peer; otherwise broadcast to everyone else in the room.
   * The `from` field is always overwritten with the sender's authoritative id.
   */
  private relay(sender: Peer, msg: SignalMessage): void {
    const room = this.rooms.get(sender.room);
    if (!room) return;

    const out: SignalMessage = { ...msg, from: sender.id };

    if (msg.to) {
      const target = room.peers.get(msg.to);
      if (target) this.send(target.socket, out);
      return;
    }

    for (const other of room.peers.values()) {
      if (other.id === sender.id) continue;
      this.send(other.socket, out);
    }
  }

  private handleLeave(peer: Peer): void {
    const room = this.rooms.get(peer.room);
    if (!room) return;
    if (!room.peers.delete(peer.id)) return;

    for (const other of room.peers.values()) {
      this.send(other.socket, {
        type: 'peer-left',
        from: peer.id,
        room: room.code,
        code: room.code,
        role: peer.role,
        name: peer.name,
        ts: Date.now(),
      });
    }

    // Reap empty rooms so `listSessions` reflects reality. NOTE: this is NOT a
    // session timeout — the room only disappears once every socket has left.
    if (room.peers.size === 0) this.rooms.delete(room.code);
  }

  /**
   * Heartbeat: ping each socket and reap any that failed to pong since the last
   * tick. This detects *dead* connections (crashed peer, dropped WiFi) so we
   * fire `peer-left` promptly — it never closes a live, responsive session.
   */
  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const peer of room.peers.values()) {
          if (!peer.alive) {
            peer.socket.terminate();
            continue;
          }
          peer.alive = false;
          try {
            peer.socket.ping();
          } catch {
            /* socket already gone; close handler will reap it */
          }
        }
      }
    }, this.heartbeatMs);
    // Don't keep the process alive solely for the heartbeat.
    this.heartbeat.unref?.();
  }

  private send(socket: WebSocket, msg: SignalMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, { type: 'error', message, ts: Date.now() });
  }

  /** Gracefully close the server and all sockets. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) {
        try {
          peer.socket.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.rooms.clear();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function parseMessage(data: RawData): SignalMessage | undefined {
  try {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!isSignalMessage(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
