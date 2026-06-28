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

import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
  /**
   * Browser-Origin allowlist for the WebSocket handshake.
   *
   * WebSocket handshakes are NOT subject to CORS, so without a check any web
   * page loaded in a browser anywhere on the LAN can open a socket to this
   * server and speak the signaling protocol (enumerate/join/hijack rooms).
   *
   * Semantics:
   *   - `undefined` / not set  -> only NON-browser clients (no `Origin` header,
   *     e.g. the Electron host, the AI bridge, native ws) are accepted; any
   *     request that carries an `Origin` is rejected. This is the safe default.
   *   - `['*']`                -> allow every Origin (explicit opt-out; use only
   *     if you understand the cross-site-WS risk).
   *   - `['http://host:5173', ...]` -> exact-match allowlist of browser Origins
   *     (e.g. the viewer dev server / the served viewer app). Non-browser
   *     clients (no Origin) are always allowed.
   */
  allowedOrigins?: string[];
  /**
   * Max bytes for a single inbound WebSocket frame. Signaling messages are tiny
   * SDP/ICE blobs (a few KB), so we cap well below ws's 100MB default to bound
   * pre-auth memory pressure. Set to 0 to fall back to the ws default.
   */
  maxPayloadBytes?: number;
  /**
   * How long (ms) an accepted socket may stay connected without sending a valid
   * `join` before it is closed. Bounds idle un-authenticated sockets. Set to 0
   * to disable.
   */
  joinTimeoutMs?: number;
  /**
   * Max concurrent viewers per room. The model is "one host + N viewers"; this
   * caps N so a single code cannot be used to attach an unbounded number of
   * simultaneous controllers. Set to 0 for unlimited (NOT recommended).
   */
  maxViewersPerRoom?: number;
  /**
   * Brute-force throttle: max failed viewer joins (wrong/unknown code) allowed
   * per remote address inside `joinFailWindowMs` before further joins from that
   * address are rejected with `too-many-attempts`. This turns the
   * `no-such-session` response into a rate-limited oracle instead of a free
   * one. Set to 0 to disable.
   */
  maxJoinFailures?: number;
  /** Sliding window (ms) for {@link maxJoinFailures}. */
  joinFailWindowMs?: number;
  /**
   * OPT-IN STUN/TURN configuration distributed to EVERY joiner (host + viewers)
   * on the `joined` acknowledgement so BOTH peers negotiate against the SAME ICE
   * servers — the prerequisite for symmetric NAT traversal / "connect from
   * anywhere". The operator supplies their own self-hosted servers (e.g. coturn
   * or a STUN URL); nothing is hardcoded and no third-party server is contacted.
   *
   * Absent or empty (the DEFAULT) means LAN-only: no ICE servers are sent and
   * the WebRTC layer behaves exactly as before. A defensive copy is stored so a
   * later mutation of the caller's array cannot change what the server hands out.
   */
  iceServers?: RTCIceServer[];
  /**
   * Whether to trust a reverse proxy's `X-Forwarded-For` header when deriving
   * the remote address used for the join-failure throttle.
   *
   * StreamScreen is a LAN-DIRECT service: clients connect straight to the TCP
   * socket, so the only trustworthy source identity is the real TCP peer
   * (`req.socket.remoteAddress`). `X-Forwarded-For` is client-supplied and
   * trivially forgeable, so an attacker on the LAN could rotate it on every
   * request to never accumulate failures against a single key and defeat the
   * brute-force throttle.
   *
   * - `false` (DEFAULT) -> IGNORE `X-Forwarded-For`; always key the throttle on
   *   the real TCP peer address. Safe default for direct LAN deployments.
   * - `true`            -> the server sits behind a TRUSTED reverse proxy that
   *   sets `X-Forwarded-For`; the left-most entry is honored as the client
   *   address (falling back to the socket peer when absent).
   */
  trustProxy?: boolean;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CODE_DIGITS = 6;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB: ample for SDP/ICE.
const DEFAULT_JOIN_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_VIEWERS_PER_ROOM = 8;
const DEFAULT_MAX_JOIN_FAILURES = 20;
const DEFAULT_JOIN_FAIL_WINDOW_MS = 60_000;

/**
 * Generate a numeric session code with the requested number of digits.
 * The first digit is always 1..9 so the code never has a leading zero and
 * always renders as exactly `digits` characters.
 *
 * SECURITY: the session code is the ONLY authorization gate for a session, so
 * it must be unguessable. We draw every digit from `node:crypto`'s CSPRNG
 * (`randomInt`) — never `Math.random()`, whose output is predictable and
 * seed-recoverable and would make active codes enumerable.
 */
export function generateCode(digits = DEFAULT_CODE_DIGITS): string {
  const d = Math.min(9, Math.max(6, Math.floor(digits)));
  let code = String(1 + randomInt(9)); // first digit 1..9 (no leading zero)
  for (let i = 1; i < d; i++) {
    code += String(randomInt(10));
  }
  return code;
}

/**
 * Events emitted by {@link SignalingServer}. `sessions-changed` fires whenever
 * the set of LIVE host rooms changes — i.e. a host joins (a room gains its host)
 * or a host leaves (a room is reaped). This is the hook LAN discovery uses to
 * advertise/withdraw the codes of ACTUAL joinable host sessions, so every
 * discovered code maps to a real room rather than a placeholder minted at
 * startup with no host behind it. The payload is the current snapshot from
 * {@link SignalingServer.listSessions}.
 */
export interface SignalingServerEvents {
  'sessions-changed': [sessions: SessionInfo[]];
}

export class SignalingServer extends EventEmitter<SignalingServerEvents> {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly heartbeatMs: number;
  private readonly codeDigits: number;
  private readonly allowedOrigins?: Set<string>;
  private readonly allowAnyOrigin: boolean;
  private readonly maxPayloadBytes: number;
  private readonly joinTimeoutMs: number;
  private readonly maxViewersPerRoom: number;
  private readonly maxJoinFailures: number;
  private readonly joinFailWindowMs: number;
  private readonly trustProxy: boolean;
  /**
   * Operator-configured ICE servers, distributed to every joiner on the `joined`
   * ack. Stored as a defensive deep-copy; empty array means LAN-only (default).
   */
  private readonly iceServers: RTCIceServer[];
  /** Sliding-window failed-join counters, keyed by remote address. */
  private readonly joinFailures = new Map<string, { count: number; first: number }>();
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(opts: SignalingServerOptions = {}) {
    super();
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.codeDigits = opts.codeDigits ?? DEFAULT_CODE_DIGITS;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.joinTimeoutMs = opts.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    this.maxViewersPerRoom = opts.maxViewersPerRoom ?? DEFAULT_MAX_VIEWERS_PER_ROOM;
    this.maxJoinFailures = opts.maxJoinFailures ?? DEFAULT_MAX_JOIN_FAILURES;
    this.joinFailWindowMs = opts.joinFailWindowMs ?? DEFAULT_JOIN_FAIL_WINDOW_MS;
    this.trustProxy = opts.trustProxy ?? false;
    // Defensive deep-copy so a later mutation of the caller's array (or its
    // entries) cannot change what we distribute. Empty/omitted => LAN-only.
    this.iceServers = cloneIceServers(opts.iceServers);

    // Resolve the Origin policy once. `['*']` is an explicit allow-all opt-out;
    // an empty/undefined list means "non-browser clients only".
    this.allowAnyOrigin = !!opts.allowedOrigins?.includes('*');
    this.allowedOrigins = this.allowAnyOrigin
      ? undefined
      : new Set(opts.allowedOrigins ?? []);

    const wsOpts = {
      verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
        this.verifyOrigin(info.origin ?? info.req.headers.origin, info.req),
      ...(this.maxPayloadBytes > 0 ? { maxPayload: this.maxPayloadBytes } : {}),
    };

    if (opts.server) {
      this.wss = new WebSocketServer({ server: opts.server, ...wsOpts });
    } else {
      this.wss = new WebSocketServer({ port: opts.port ?? 0, ...wsOpts });
    }

    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
    this.startHeartbeat();
  }

  /**
   * Decide whether a WebSocket handshake from `origin` may proceed.
   *
   * The threat is a CROSS-SITE WebSocket: a malicious page on some *other*
   * origin (loaded in a browser anywhere on the LAN) opening a socket to this
   * server and speaking the protocol. WS handshakes ignore CORS, so we gate the
   * `Origin` header ourselves. The policy is:
   *
   *   1. No `Origin` header  -> non-browser client (Electron host, AI bridge,
   *      native `ws`). Always allowed — these trusted processes are the point.
   *   2. `allowAnyOrigin`    -> explicit allow-all opt-out (`allowedOrigins: ['*']`).
   *   3. Explicit allowlist  -> Origin must be an exact member.
   *   4. Otherwise (no allowlist configured) -> the DEFAULT LAN/dev policy:
   *      accept Origins that are plausibly a legitimate local viewer and reject
   *      clearly foreign public ones. Concretely an Origin is accepted when its
   *      host is loopback (localhost / 127.0.0.0/8 / ::1), is the SAME host as
   *      the request `Host` (the viewer served from the signaling host, on ANY
   *      port — e.g. Vite :5173 talking to signaling :8787), or is a private /
   *      link-local LAN IP (10/8, 172.16-31, 192.168, 169.254, fc00::/7,
   *      fe80::/10). Port is ignored throughout. A foreign public Origin
   *      (https://evil.example) matches none of these and is rejected, so the
   *      zero-config + documented dev-viewer flows work without
   *      STREAMSCREEN_ALLOWED_ORIGINS while cross-site public pages stay out.
   */
  private verifyOrigin(origin: string | undefined, req: IncomingMessage): boolean {
    // 1. Non-browser client.
    if (!origin) return true;
    // 2. Explicit allow-all.
    if (this.allowAnyOrigin) return true;
    // 3. Explicit allowlist (when one was configured) takes precedence.
    if (this.allowedOrigins && this.allowedOrigins.size > 0) {
      return this.allowedOrigins.has(origin);
    }
    // 4. Default LAN/dev policy.
    return isLanOrDevOrigin(origin, req.headers.host);
  }

  /**
   * The ICE servers this server distributes on the `joined` ack (defensive
   * copy). Empty when none were configured (LAN-only default).
   */
  getIceServers(): RTCIceServer[] {
    return cloneIceServers(this.iceServers);
  }

  /** The bound port (useful when constructed with `port: 0`). */
  get port(): number {
    const addr = this.wss.address();
    if (addr && typeof addr === 'object') return addr.port;
    return 0;
  }

  /**
   * Snapshot of all active sessions, for the REST `/api/sessions` endpoint and
   * the `sessions-changed` payload. Only rooms with a CURRENTLY-LIVE host are
   * returned: a hostless room (host disconnected, viewers lingering) is NOT a
   * joinable session, so surfacing it would feed a dead code to mDNS discovery
   * and REST while a new viewer joining that code gets `no-such-session`.
   */
  listSessions(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const room of this.rooms.values()) {
      if (!this.hasHost(room)) continue;
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

  /** Does the room already contain a connected host peer? */
  private hasHost(room: Room): boolean {
    for (const p of room.peers.values()) if (p.role === 'host') return true;
    return false;
  }

  /**
   * Is this remote address currently over its failed-join budget? Expired
   * windows are reset lazily so a quiet attacker eventually gets a fresh budget.
   */
  private isJoinThrottled(addr: string): boolean {
    if (this.maxJoinFailures <= 0) return false;
    const rec = this.joinFailures.get(addr);
    if (!rec) return false;
    if (Date.now() - rec.first > this.joinFailWindowMs) {
      this.joinFailures.delete(addr);
      return false;
    }
    return rec.count >= this.maxJoinFailures;
  }

  /** Record a failed viewer join for `addr` within the sliding window. */
  private recordJoinFailure(addr: string): void {
    if (this.maxJoinFailures <= 0) return;
    const now = Date.now();
    const rec = this.joinFailures.get(addr);
    if (!rec || now - rec.first > this.joinFailWindowMs) {
      this.joinFailures.set(addr, { count: 1, first: now });
      return;
    }
    rec.count++;
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    // Peer is unregistered until it sends a valid `join`.
    let peer: Peer | undefined;
    const remoteAddr = remoteAddress(req, this.trustProxy);

    // Bound idle un-authenticated sockets: if no valid `join` arrives within
    // the deadline, close the socket so it cannot be parked indefinitely.
    let joinTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.joinTimeoutMs > 0) {
      joinTimer = setTimeout(() => {
        if (!peer) {
          this.sendError(socket, 'join-timeout');
          try {
            socket.close();
          } catch {
            /* already closing */
          }
        }
      }, this.joinTimeoutMs);
      joinTimer.unref?.();
    }
    const clearJoinTimer = (): void => {
      if (joinTimer) {
        clearTimeout(joinTimer);
        joinTimer = undefined;
      }
    };

    socket.on('message', (data: RawData) => {
      // HARDENING (P1 crash/DoS): the `message` handler runs as a `ws`
      // EventEmitter listener, so ANY synchronous throw here escapes as an
      // unhandled exception and takes down the whole signaling PROCESS — a
      // single malformed client frame would be a trivial denial-of-service that
      // kills every other live session. So the entire per-frame processing is
      // wrapped: any unexpected throw is caught, turned into a generic protocol
      // error for the offending socket, and swallowed. One bad frame can never
      // crash the server or disturb other clients. (Per-field validation below
      // still produces specific errors like `invalid-join` on the common paths;
      // this catch is the last-resort safety net for anything we missed.)
      try {
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
            peer = this.handleJoin(socket, msg, remoteAddr);
            if (peer) clearJoinTimer();
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
      } catch {
        // Last-resort safety net: a malformed frame slipped past validation and
        // threw. Never let it crash the process — respond with a generic error
        // and keep serving every other client.
        try {
          this.sendError(socket, 'invalid-message');
        } catch {
          /* socket already gone; nothing more to do */
        }
      }
    });

    socket.on('pong', () => {
      if (peer) peer.alive = true;
    });

    socket.on('close', () => {
      clearJoinTimer();
      if (peer) this.handleLeave(peer);
    });

    socket.on('error', () => {
      clearJoinTimer();
      if (peer) this.handleLeave(peer);
    });
  }

  private handleJoin(socket: WebSocket, msg: SignalMessage, remoteAddr: string): Peer | undefined {
    // VALIDATE/COERCE join fields BEFORE trimming/using them. `isSignalMessage`
    // (core) only checks `type`, so an authenticated socket can put a non-string
    // in `code`/`name`/`role` (e.g. `{type:'join',role:'viewer',code:123}`).
    // Calling `.trim()` on a number throws, and that throw used to escape the WS
    // `message` handler and crash the PROCESS. We now reject malformed shapes
    // with a protocol error and coerce the benign ones, so a bad join frame is a
    // normal error response — never a crash.
    //
    //  - `code` (and the legacy `room` alias): if present it MUST be a string;
    //    a non-string is a protocol violation -> `invalid-join`. (Whether the
    //    string is all-digits is enforced downstream alongside room lookup; here
    //    we only guarantee `.trim()` is safe to call.)
    //  - `name`: coerce a missing/non-string value to '' so the existing
    //    `||` default ("host"/"viewer") still applies.
    //  - `role`: any value other than the literal 'host' falls back to 'viewer'
    //    (unchanged behavior); a non-string role can never be 'host', so it is
    //    safely treated as a viewer.
    const rawCode = msg.code ?? msg.room;
    if (rawCode !== undefined && typeof rawCode !== 'string') {
      this.sendError(socket, 'invalid-join');
      return undefined;
    }

    const role: Role = msg.role === 'host' ? 'host' : 'viewer';
    const rawName = msg.name;
    const name =
      (typeof rawName === 'string' ? rawName : '').trim() || (role === 'host' ? 'host' : 'viewer');

    let code = (rawCode ?? '').trim();

    if (role === 'host') {
      // A host without a code starts a brand-new session; mint one.
      if (!code) code = this.mintCode();
    } else {
      // Viewers must target an existing room. Apply the brute-force throttle to
      // viewer joins so the `missing-code`/`no-such-session` responses cannot be
      // used as an unlimited code-enumeration oracle.
      if (this.isJoinThrottled(remoteAddr)) {
        this.sendError(socket, 'too-many-attempts');
        return undefined;
      }
      if (!code) {
        this.recordJoinFailure(remoteAddr);
        this.sendError(socket, 'missing-code');
        return undefined;
      }
      if (!this.rooms.has(code)) {
        this.recordJoinFailure(remoteAddr);
        this.sendError(socket, 'no-such-session');
        return undefined;
      }
    }

    const existing = this.rooms.get(code);

    // ONE-HOST-PER-ROOM (authoritative). A room may have exactly one host. A
    // second `host` join on a code that already has a live host is rejected
    // outright — without this, a duplicate/rogue host could overwrite
    // `room.hostName`, receive the real host's offers (broadcast relay), and
    // corrupt session topology / offer routing. Re-joining is only possible
    // once the previous host's socket has left and the room is reaped.
    if (role === 'host' && existing && this.hasHost(existing)) {
      this.sendError(socket, 'host-exists');
      return undefined;
    }

    // A viewer can only join a room that actually has a host; otherwise it would
    // attach to a hostless (or host-pending) room with nobody to negotiate with.
    if (role === 'viewer' && existing && !this.hasHost(existing)) {
      this.recordJoinFailure(remoteAddr);
      this.sendError(socket, 'no-such-session');
      return undefined;
    }

    // Cap simultaneous controllers per room.
    if (
      role === 'viewer' &&
      existing &&
      this.maxViewersPerRoom > 0 &&
      this.countViewers(existing) >= this.maxViewersPerRoom
    ) {
      this.sendError(socket, 'room-full');
      return undefined;
    }

    let room = existing;
    if (!room) {
      room = { code, hostName: name, createdAt: Date.now(), peers: new Map() };
      this.rooms.set(code, room);
    } else if (role === 'host') {
      // First host into a pre-existing (but hostless) room sets the name.
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

    // Acknowledge the joiner with its identity + the resolved code, and — when
    // the operator configured ICE servers — the SAME STUN/TURN list every other
    // peer in this room receives, so host and viewer negotiate against an
    // identical config (required for NAT traversal). Omitted when empty so the
    // LAN-only default keeps the ack byte-for-byte unchanged.
    const joined: SignalMessage = {
      type: 'joined',
      from: peer.id,
      code,
      room: code,
      role,
      name,
      ts: Date.now(),
    };
    if (this.iceServers.length > 0) joined.iceServers = cloneIceServers(this.iceServers);
    this.send(socket, joined);

    // Notify existing peers that someone arrived, and tell the joiner who is
    // already present so a viewer immediately knows the host id to offer to.
    for (const other of room.peers.values()) {
      if (other.id === peer.id) continue;
      const arrived: SignalMessage = {
        type: 'peer-joined',
        from: peer.id,
        room: code,
        code,
        role: peer.role,
        name: peer.name,
        ts: Date.now(),
      };
      // HOST-ONLY metadata: tell the host the joining VIEWER's stable socket
      // source address (the SAME value used as the join-throttle key — socket
      // remoteAddress, trust-proxy aware). Unlike the per-connection peer UUID
      // / DTLS channel binding, this survives disconnect+rejoin, so the host can
      // key PIN-lockout state on an identity an attacker cannot rotate by
      // reconnecting. It carries NO secret (no PIN/token/proof), only a coarse
      // network identity. Sent ONLY to the host, and only for viewer arrivals,
      // so we never leak one viewer's address to another viewer.
      if (other.role === 'host' && peer.role === 'viewer') {
        arrived.sourceAddr = remoteAddr;
      }
      this.send(other.socket, arrived);
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

    // A host joining makes this room a LIVE, joinable session — notify listeners
    // (LAN discovery) so the room's code starts being advertised. Viewer joins
    // don't change the set of joinable host rooms, so they don't emit.
    if (role === 'host') this.emitSessionsChanged();

    return peer;
  }

  /**
   * Notify listeners that the set of live host sessions changed. Guarded so a
   * misbehaving listener can never take down the signaling server.
   */
  private emitSessionsChanged(): void {
    try {
      this.emit('sessions-changed', this.listSessions());
    } catch {
      /* a listener threw; discovery is best-effort and must not break signaling */
    }
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

    // HOST DEPARTURE REAPS THE ROOM. When the host leaves, the room is no longer
    // joinable: there is nobody to negotiate WebRTC with, the code is dead, and
    // leaving the room around would let `listSessions()` advertise a code that a
    // new viewer cannot actually join (it'd get `no-such-session`). So when the
    // host goes, explicitly notify every remaining viewer that the host
    // disconnected, disconnect them, and delete the room. (A viewer leaving a
    // still-hosted room is the ordinary case and leaves the room intact.)
    let reaped = room.peers.size === 0;
    if (peer.role === 'host' && !reaped) {
      for (const other of room.peers.values()) {
        this.sendError(other.socket, 'host-disconnected');
        try {
          other.socket.close();
        } catch {
          /* already closing */
        }
      }
      room.peers.clear();
      reaped = true;
    }

    // Reap empty / hostless rooms so `listSessions` reflects reality. NOTE: this
    // is NOT a session timeout — the room only disappears once the host leaves or
    // every socket has closed.
    if (reaped) this.rooms.delete(room.code);

    // The set of live host sessions changes when a host leaves (the room is no
    // longer joinable) or when a hosted room is reaped. Tell discovery so it can
    // withdraw the now-dead code. A viewer leaving a still-hosted room does not
    // change the joinable-host set, so it doesn't emit.
    if (peer.role === 'host' || reaped) this.emitSessionsChanged();
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
      // Prune expired brute-force counters so the map cannot grow unbounded.
      const now = Date.now();
      for (const [addr, rec] of this.joinFailures) {
        if (now - rec.first > this.joinFailWindowMs) this.joinFailures.delete(addr);
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

/**
 * Best-effort remote address used to key the brute-force join throttle.
 *
 * SECURITY: by default we use the REAL TCP peer (`req.socket.remoteAddress`) and
 * IGNORE the client-supplied `X-Forwarded-For` header entirely. StreamScreen is
 * a LAN-direct service, so XFF is attacker-controlled — honoring it would let a
 * caller rotate the header on every request to dodge the per-source throttle
 * (each spoofed value gets its own fresh failure budget). Only when the server
 * is EXPLICITLY configured to sit behind a trusted reverse proxy
 * (`trustProxy: true`) do we honor the left-most XFF entry as the client
 * address, falling back to the socket peer when XFF is absent. Returns 'unknown'
 * if no address is available so the throttle still groups anonymous sockets
 * rather than disabling itself.
 */
function remoteAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const first = xff.split(',')[0]!.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * DEFAULT (no-allowlist) Origin policy for the WS handshake. Decide whether a
 * browser-supplied `Origin` is a plausibly-legitimate LAN/dev viewer rather than
 * a foreign public page mounting a cross-site WebSocket.
 *
 * Accept when the Origin's HOSTNAME (port ignored throughout) is:
 *   - loopback: `localhost`, `127.0.0.0/8`, or `::1`; OR
 *   - the SAME hostname as the request `Host` header (the viewer served from the
 *     signaling host itself — possibly on a different port, e.g. Vite :5173
 *     connecting to signaling :8787); OR
 *   - a private / link-local LAN address: 10/8, 172.16–31/12, 192.168/16,
 *     169.254/16, or IPv6 ULA/link-local (fc00::/7, fe80::/10).
 *
 * Everything else (a public hostname / public IP) is rejected. Returns false if
 * the Origin is unparseable, so the default policy fails closed.
 */
/**
 * Extract the bare hostname from a browser `Origin`, with IPv6 surrounding
 * brackets stripped so the loopback / private-address checks see the raw
 * address form they expect (e.g. `[::1]` -> `::1`, `[fd00::2]` -> `fd00::2`).
 *
 * `new URL(origin).hostname` is used when possible, but in this Node runtime it
 * (a) RETAINS the surrounding brackets for IPv6 literals and (b) THROWS for an
 * IPv6 literal carrying a zone-id (`http://[fe80::1%eth0]:5173`). So when URL
 * parsing fails we fall back to extracting the `[...]` host ourselves, and we
 * always strip a surrounding bracket pair from the result. IPv4/named hosts are
 * returned unchanged. Returns undefined if no hostname can be recovered.
 */
function originHostname(origin: string): string | undefined {
  let host: string | undefined;
  try {
    host = new URL(origin).hostname || undefined;
  } catch {
    // URL parsing rejects zone-id'd IPv6 literals; recover the bracketed host
    // (and any `host:port`) from the scheme-relative authority manually.
    const m = origin.match(/^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/?#]*)/i);
    host = m?.[1];
  }
  if (!host) return undefined;
  // Strip a single surrounding pair of IPv6 brackets, if present.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return host || undefined;
}

export function isLanOrDevOrigin(origin: string, host: string | undefined): boolean {
  const originHost = originHostname(origin);
  if (!originHost) return false;

  // Same host as the server (any port) — covers the served viewer and the Vite
  // dev viewer (:5173) pointing at the signaling port.
  const serverHost = hostnameOf(host);
  if (serverHost && originHost.toLowerCase() === serverHost.toLowerCase()) return true;

  if (isLoopbackHost(originHost)) return true;
  if (isPrivateLanHost(originHost)) return true;

  return false;
}

/** Extract the bare hostname (no port, IPv6 brackets stripped) from a `Host` header. */
function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    // URL parsing normalises bracketed IPv6 and strips the port for us.
    return new URL(`http://${host}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Loopback hostnames: `localhost`, 127.0.0.0/8, and IPv6 `::1`. */
function isLoopbackHost(h: string): boolean {
  const host = h.toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * Private / link-local LAN addresses (RFC 1918 + RFC 3927 + IPv6 ULA/link-local).
 * IPv6 may arrive zone-id-suffixed (`fe80::1%eth0`); strip that before matching.
 */
function isPrivateLanHost(h: string): boolean {
  const host = h.toLowerCase().split('%')[0]!;
  // IPv4 RFC 1918 + link-local 169.254/16.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 ULA fc00::/7 (fc.. / fd..) and link-local fe80::/10 (fe8/fe9/fea/feb).
  if (/^f[cd][0-9a-f]*:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;
  return false;
}

/**
 * Defensive deep-copy of an ICE-server list. Returns a fresh array of fresh
 * entries (with `urls` cloned when it is an array) so neither the caller's
 * original array nor an entry can be mutated to change what the server hands out
 * or what `getIceServers()` later returns. `undefined`/empty yields `[]`.
 */
function cloneIceServers(servers: RTCIceServer[] | undefined): RTCIceServer[] {
  if (!servers || servers.length === 0) return [];
  return servers.map((s) => {
    const copy: RTCIceServer = {
      urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
    };
    if (s.username !== undefined) copy.username = s.username;
    if (s.credential !== undefined) copy.credential = s.credential;
    return copy;
  });
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
