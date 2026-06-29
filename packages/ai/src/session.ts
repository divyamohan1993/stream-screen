/**
 * RemoteDesktopSession — the shared control engine that both the MCP server and
 * the REST API drive. It owns a single viewer-side {@link Peer} connection to a
 * host and turns high-level tool calls (connect, screenshot, click, …) into
 * signaling + {@link InputEvent}s over the data channel.
 *
 * WebRTC runtime: a node WebRTC implementation is required to actually connect.
 * `@roamhq/wrtc` (preferred) and `werift` ship native/heavy bits and are
 * therefore OPTIONAL — loaded via dynamic `import()`. When none is available the
 * session stays valid but every connect/capture/control call rejects with a
 * clear "requires native webrtc runtime" error, and the MCP/REST surfaces remain
 * fully introspectable and testable. A runtime may also be injected directly
 * (for tests or alternative back-ends).
 *
 * Always free, no time limits: there are no session timers, usage counters, or
 * licensing checks anywhere in this class.
 */

import { deflateSync } from 'node:zlib';
import {
  Peer,
  SignalingClient,
  isIceServerList,
  isValidSessionCode,
  parseIceServers,
} from '@stream-screen/core';
import type {
  AdaptiveStats,
  ControlMessage,
  InputEvent,
  MonitorInfo,
  QualityPreset,
} from '@stream-screen/core';
import {
  clickEvents,
  comboEvents,
  moveMouseEvent,
  pressKeyEvents,
  sendKeysEvents,
  toQualityPreset,
  typeTextEvents,
} from './tools.js';

/**
 * The minimal {@link Peer} surface this session drives. Declaring it as an
 * interface (rather than depending on the concrete class) lets tests inject a
 * lightweight fake peer that records the events/control messages it receives —
 * see {@link RemoteDesktopSession.attachTestPeer}.
 */
export interface SessionPeer {
  sendInput(e: InputEvent): void;
  sendControl(m: ControlMessage): void;
  onControl(cb: (m: ControlMessage) => void): void;
  getStats(): Promise<AdaptiveStats>;
  close(): void;
}

/** A discoverable host returned by {@link RemoteDesktopSession.listHosts}. */
export interface HostEntry {
  code: string;
  name: string;
  /**
   * The signaling WebSocket URL this host is reachable at, when discovery
   * advertised one (built from the mDNS `address`/`port`, IPv6-bracketed). A host
   * found via `/api/discover` on ANOTHER LAN machine runs its OWN signaling
   * server at this endpoint — joining its code against this AI server's own
   * `signalingUrl` would hit the wrong server and fail with `no-such-session`.
   * Omitted when no usable address was advertised (e.g. `/api/sessions` rows or
   * mDNS records without an address), in which case {@link connect} falls back to
   * the configured {@link SessionOptions.signalingUrl}.
   */
  signalingUrl?: string;
}

/**
 * The minimal {@link SignalingClient} surface {@link RemoteDesktopSession.connect}
 * drives. Declaring it as an interface (rather than depending on the concrete
 * class) lets tests inject a lightweight fake that can fire `joined`/`error`
 * acknowledgements without a real WebSocket — see
 * {@link SessionOptions.signalingClientFactory}.
 */
export interface SessionSignaling {
  connect(): Promise<void>;
  join(p: { room?: string; code?: string; role: string; name?: string }): void;
  on(type: string, cb: (m: SignalAck) => void): void;
  off(type: string, cb: (m: SignalAck) => void): void;
  close(): void;
}

/**
 * The subset of a signaling acknowledgement message the connect handshake reads.
 * `iceServers` is the server-distributed STUN/TURN list carried on the `joined`
 * ack (validated with core `isIceServerList`); it is optional and may be absent
 * (LAN-only) or malformed (ignored).
 */
export interface SignalAck {
  type: string;
  message?: string;
  iceServers?: unknown;
}

/**
 * How long {@link RemoteDesktopSession.connect} waits for the signaling server's
 * `joined` acknowledgement after sending `join`, before giving up. This is ONLY
 * a connect handshake timeout — it is NOT a session time limit or usage cap;
 * once connected the session runs indefinitely.
 */
export const JOIN_ACK_TIMEOUT_MS = 10_000;

/** Thrown when the signaling server rejects the join (e.g. no-such-session). */
export class JoinRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinRejectedError';
  }
}

/** Options for {@link RemoteDesktopSession}. */
export interface SessionOptions {
  /**
   * Signaling server URL, e.g. `ws://192.168.1.5:8787`. Defaults to
   * `STREAMSCREEN_SIGNALING_URL` or `ws://127.0.0.1:8787`.
   */
  signalingUrl?: string;
  /**
   * HTTP base URL of the signaling server's REST API (used by
   * {@link RemoteDesktopSession.listHosts}). The signaling WS and REST surfaces
   * share one HTTP port, so when omitted this is derived from `signalingUrl`
   * (`ws://`→`http://`, `wss://`→`https://`). Defaults to
   * `STREAMSCREEN_SIGNALING_HTTP_URL` else the derived value.
   */
  signalingHttpUrl?: string;
  /** STUN/TURN servers (LAN P2P usually needs none). */
  iceServers?: RTCIceServer[];
  /**
   * Injected `RTCPeerConnection` constructor. When omitted, the session tries to
   * load an optional node WebRTC library at connect time.
   */
  rtcPeerConnection?: typeof RTCPeerConnection;
  /** Name this viewer advertises to the host. */
  viewerName?: string;
  /**
   * Bearer token for the signaling REST API. When set, it is presented to
   * `/api/sessions` so that endpoint returns UN-REDACTED session codes (the REST
   * server masks codes by default for unauthenticated callers). Without it, the
   * `/api/sessions` fallback only yields redacted codes like `****56`, which are
   * not joinable — {@link RemoteDesktopSession.listHosts} drops those. Defaults
   * to `STREAMSCREEN_TOKEN`.
   */
  token?: string;
  /**
   * Injected factory that builds the signaling client used by {@link connect}.
   * Defaults to constructing a real `@stream-screen/core` `SignalingClient`. FOR
   * TESTS: lets a test supply a fake that fires `joined`/`error` acknowledgements
   * so the connect handshake can be exercised without a WebSocket.
   */
  signalingClientFactory?: (url: string) => SessionSignaling;
  /**
   * Override the connect handshake timeout (ms). Purely the wait for the `joined`
   * acknowledgement — NOT a session time limit. Defaults to {@link JOIN_ACK_TIMEOUT_MS}.
   */
  joinTimeoutMs?: number;
}

/** A captured frame: raw encoded image bytes plus its declared MIME type. */
export interface CapturedFrame {
  data: Buffer;
  mimeType: string;
}

/** Thrown when no node WebRTC runtime is available to back the connection. */
export class WebRtcUnavailableError extends Error {
  constructor() {
    super(
      'This operation requires a native WebRTC runtime. Install the optional ' +
        'dependency "@roamhq/wrtc" (or provide opts.rtcPeerConnection) to enable ' +
        'remote desktop connections from this AI server.',
    );
    this.name = 'WebRtcUnavailableError';
  }
}

/** Thrown when a control/capture tool is used before {@link connect}. */
export class NotConnectedError extends Error {
  constructor() {
    super('Not connected: call connect({ code }) before using this tool.');
    this.name = 'NotConnectedError';
  }
}

const DEFAULT_SIGNALING_URL = 'ws://127.0.0.1:8787';

/**
 * Derive the signaling server's HTTP base URL from its WebSocket URL. The
 * signaling WS and REST surfaces share a single HTTP port, so `ws://` maps to
 * `http://` and `wss://` to `https://` (any path/query/hash is dropped). Falls
 * back to returning the input unchanged if it cannot be parsed.
 */
export function deriveSignalingHttpUrl(signalingUrl: string): string {
  try {
    const u = new URL(signalingUrl);
    if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol === 'wss:') u.protocol = 'https:';
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    // Strip the trailing slash so callers can append `/api/...` cleanly.
    return u.toString().replace(/\/+$/, '');
  } catch {
    return signalingUrl.replace(/\/+$/, '');
  }
}

/** The shape `/api/discover` and `/api/sessions` return (subset we read). */
interface RestHost {
  code?: unknown;
  hostName?: unknown;
  name?: unknown;
  /** mDNS-advertised address of the host's signaling server (`/api/discover`). */
  address?: unknown;
  /** mDNS-advertised port of the host's signaling server (`/api/discover`). */
  port?: unknown;
}

/**
 * Build a signaling WebSocket URL for a discovered host from its advertised
 * `address`/`port`. Mirrors the viewer's `signalingUrlForHost`: a host found via
 * mDNS on another LAN machine runs its own signaling server at that endpoint, so
 * its code must be joined there — NOT against this AI server's own
 * `signalingUrl`. Returns `undefined` when no usable address/port was advertised
 * so the caller falls back to the configured signaling URL. IPv6 literals are
 * bracketed so the resulting `host:port` authority is well-formed.
 */
export function signalingUrlForDiscoveredHost(h: RestHost): string | undefined {
  const address = typeof h.address === 'string' ? h.address.trim() : '';
  if (!address) return undefined;
  const port = typeof h.port === 'number' ? h.port : Number(h.port);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  const authority = address.includes(':') ? `[${address}]` : address;
  return `ws://${authority}:${port}`;
}

/**
 * Attempt to resolve a node WebRTC `RTCPeerConnection` constructor.
 * Tries `@roamhq/wrtc` then `werift`. Returns `null` if neither is installed.
 */
async function resolveNodeRtc(): Promise<typeof RTCPeerConnection | null> {
  // Prefer @roamhq/wrtc (drop-in DOM-compatible RTCPeerConnection).
  try {
    const mod = (await import('@roamhq/wrtc')) as {
      default?: { RTCPeerConnection?: typeof RTCPeerConnection };
      RTCPeerConnection?: typeof RTCPeerConnection;
    };
    const ctor = mod.RTCPeerConnection ?? mod.default?.RTCPeerConnection;
    if (typeof ctor === 'function') return ctor;
  } catch {
    /* not installed — try the next */
  }
  // Fall back to werift if present. The specifier is held in a variable so the
  // type-checker does not require `werift` to be installed (it is an optional,
  // un-declared runtime fallback resolved purely dynamically).
  try {
    const weriftSpecifier = 'werift';
    const mod = (await import(weriftSpecifier)) as {
      RTCPeerConnection?: typeof RTCPeerConnection;
    };
    if (typeof mod.RTCPeerConnection === 'function') return mod.RTCPeerConnection;
  } catch {
    /* not installed */
  }
  return null;
}

/** A frame delivered by the native `@roamhq/wrtc` video sink. */
interface NativeVideoFrameEvent {
  frame: { width: number; height: number; data: Uint8Array };
}

/** The subset of `@roamhq/wrtc`'s nonstandard `RTCVideoSink` we rely on. */
interface NativeVideoSink {
  onframe: ((e: NativeVideoFrameEvent) => void) | null;
  /** Releases the underlying native sink; present on `@roamhq/wrtc`'s sink. */
  stop?: () => void;
}

type NativeVideoSinkCtor = new (track: unknown) => NativeVideoSink;

export class RemoteDesktopSession {
  private readonly opts: SessionOptions;
  private readonly signalingUrl: string;
  private readonly signalingHttpUrl: string;
  private readonly token: string | undefined;

  private signaling: SignalingClient | null = null;
  private peer: SessionPeer | null = null;
  private rtcCtor: typeof RTCPeerConnection | null;
  private connectedCode: string | null = null;
  /**
   * The resolved signaling endpoint (WebSocket URL) the current session is
   * connected to — captured alongside {@link connectedCode} so idempotency keys
   * on BOTH the code AND the endpoint. In multi-host/multi-server setups a
   * numeric code is not globally unique (code collisions across servers, or an
   * explicit `signalingUrl` override), so comparing the code alone would let a
   * `connect(code, otherEndpoint)` short-circuit while still targeting the OLD
   * host. `null` whenever {@link connectedCode} is `null` (disconnected).
   */
  private connectedEndpoint: string | null = null;

  /**
   * The explicit ICE-server OVERRIDE for this session: the local
   * {@link SessionOptions.iceServers} if supplied, else the operator's
   * `STREAMSCREEN_ICE_SERVERS` env (parsed via core {@link parseIceServers}).
   * When non-empty it wins over the server-distributed list — exactly the
   * precedence host/viewer use. Empty (the default) means "no override", so the
   * server-distributed list (or LAN-only `[]`) is used. Resolved once in the
   * constructor; never mutated.
   */
  private readonly iceOverride: RTCIceServer[];
  /**
   * ICE servers distributed by the signaling server on the most recent `joined`
   * ack (the server-distributed STUN/TURN list — see core {@link
   * isIceServerList}). Captured during the join handshake and used to build the
   * {@link Peer} so BOTH host and viewer negotiate against the SAME config,
   * UNLESS {@link iceOverride} is set. `null` until a `joined` ack has been
   * observed; an empty array means the server explicitly distributed none.
   */
  private serverIceServers: RTCIceServer[] | null = null;

  /** Pending resolvers awaiting the host's `monitors` reply (list_monitors). */
  private monitorWaiters: Array<(list: MonitorInfo[]) => void> = [];
  /** Most recent monitor list reported by the host, if any. */
  private lastMonitors: MonitorInfo[] | null = null;

  /**
   * Maps a discovered host code to the signaling endpoint it was advertised at,
   * captured from the last {@link listHosts}. Lets `connect(code)` alone reach a
   * host on another LAN machine: a code present here joins against that host's
   * own signaling server, not this AI server's default {@link signalingUrl}.
   */
  private discoveredEndpoints = new Map<string, string>();

  /** Most recent decoded video frame, kept for screenshot/OCR. */
  private lastFrame: CapturedFrame | null = null;
  /** Frame sink installed on the inbound track, if the runtime supports it. */
  private frameSink: ((frame: CapturedFrame) => void) | null = null;
  /**
   * The native `@roamhq/wrtc` `RTCVideoSink` attached to the inbound track, when
   * the runtime supports it. Held on the instance for the session's lifetime so
   * it is not garbage-collected — a collected sink stops delivering frames even
   * while the connection stays up, starving screenshot/ocr_screen. Cleared (and
   * stopped) on {@link disconnect} so a reconnect creates a fresh one.
   */
  private videoSink: NativeVideoSink | null = null;

  constructor(opts: SessionOptions = {}) {
    this.opts = opts;
    this.signalingUrl =
      opts.signalingUrl ?? process.env.STREAMSCREEN_SIGNALING_URL ?? DEFAULT_SIGNALING_URL;
    this.signalingHttpUrl =
      opts.signalingHttpUrl ??
      process.env.STREAMSCREEN_SIGNALING_HTTP_URL ??
      deriveSignalingHttpUrl(this.signalingUrl);
    this.token = opts.token ?? process.env.STREAMSCREEN_TOKEN ?? undefined;
    this.rtcCtor = opts.rtcPeerConnection ?? null;
    // Resolve the explicit ICE override once: a local list wins; otherwise the
    // operator's STREAMSCREEN_ICE_SERVERS env (parsed leniently — garbage -> []).
    // Both shapes normalize to RTCIceServer[]; an empty result means "no override".
    this.iceOverride =
      opts.iceServers && opts.iceServers.length > 0
        ? opts.iceServers
        : parseIceServers(process.env.STREAMSCREEN_ICE_SERVERS);
  }

  /**
   * The ICE servers this session will (or did) build its {@link Peer} with: the
   * explicit override (local {@link SessionOptions.iceServers} or
   * `STREAMSCREEN_ICE_SERVERS`) when non-empty, otherwise the server-distributed
   * list from the `joined` ack, otherwise an empty array (LAN-only default) —
   * exactly the precedence host and viewer use. Returns a defensive copy.
   */
  get effectiveIceServers(): RTCIceServer[] {
    const chosen =
      this.iceOverride.length > 0 ? this.iceOverride : (this.serverIceServers ?? []);
    return chosen.map((s) => ({ ...s }));
  }

  /** Whether a connection is currently established. */
  get connected(): boolean {
    return this.peer !== null && this.connectedCode !== null;
  }

  /** The session code we are connected to, if any. */
  get code(): string | null {
    return this.connectedCode;
  }

  /**
   * List host machines reachable through the signaling server by querying its
   * REST API over HTTP (Node global `fetch`). We prefer `/api/discover` (the
   * mDNS browse of LAN hosts) and fall back to `/api/sessions` (the live rooms
   * on this signaling server) when discovery yields nothing. Both endpoints
   * return objects carrying a `code` and a `hostName`, which we normalize to the
   * {@link HostEntry} shape.
   *
   * Why REST and not the WebSocket `hosts` message: the signaling WS server only
   * handles join/ping/pong/offer/answer/ice and ignores a `hosts` request, so a
   * WS-based query would always time out to `[]`. Querying the REST endpoint is
   * the truthful, supported path — every code returned maps to a live, joinable
   * host room (or an advertised LAN host).
   *
   * Returns `[]` only on a genuine failure (network error, non-2xx, malformed
   * body, or timeout). Never throws.
   */
  async listHosts(timeoutMs = 1500): Promise<HostEntry[]> {
    // Prefer discovered LAN hosts (`/api/discover` returns full codes). It is an
    // open endpoint, so no token is needed.
    const discovered = await this.fetchHosts('/api/discover', timeoutMs);
    if (discovered.length > 0) return this.rememberEndpoints(discovered);
    // Fall back to this server's live sessions. The REST server REDACTS codes
    // (e.g. `****56`) for unauthenticated callers, so present the configured
    // bearer token to obtain UN-REDACTED, joinable codes. Without a token any
    // redacted/invalid code is dropped by `toHostEntry`, so the fallback only
    // ever returns USABLE host codes.
    return this.rememberEndpoints(await this.fetchHosts('/api/sessions', timeoutMs, this.token));
  }

  /**
   * Refresh {@link discoveredEndpoints} from a freshly fetched host list so a
   * later `connect(code)` resolves the endpoint that host was advertised at. The
   * map is replaced (not merged) each call so it always reflects the latest
   * discovery snapshot — stale endpoints never linger.
   */
  private rememberEndpoints(hosts: HostEntry[]): HostEntry[] {
    this.discoveredEndpoints = new Map(
      hosts
        .filter((h): h is HostEntry & { signalingUrl: string } => Boolean(h.signalingUrl))
        .map((h) => [h.code, h.signalingUrl]),
    );
    return hosts;
  }

  /**
   * GET a signaling REST endpoint that returns an array of host-like objects and
   * normalize it to {@link HostEntry}[]. Resolves to `[]` on any failure so the
   * tool/REST surface degrades gracefully rather than hanging or throwing.
   */
  private async fetchHosts(
    pathName: string,
    timeoutMs: number,
    token?: string,
  ): Promise<HostEntry[]> {
    const url = `${this.signalingHttpUrl}${pathName}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    // Present the bearer token so the REST server returns un-redacted codes.
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      return (body as RestHost[])
        .map((h) => this.toHostEntry(h))
        .filter((h): h is HostEntry => h !== null);
    } catch {
      // Network error, abort/timeout, or invalid JSON — degrade to empty.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Normalize a REST host record to a {@link HostEntry}, or `null` if unusable.
   *
   * A code is only USABLE if `connect` would accept it, so we drop any code that
   * fails {@link isValidSessionCode}. This includes the REDACTED codes the REST
   * server returns to unauthenticated callers on `/api/sessions` (e.g. `****56`),
   * which contain `*` and therefore never match the 6–9 digit pattern. The result
   * is that list_hosts never surfaces a code that `connect` would reject.
   */
  private toHostEntry(h: RestHost): HostEntry | null {
    const code = typeof h.code === 'string' ? h.code : undefined;
    if (!code || !isValidSessionCode(code)) return null;
    const name =
      (typeof h.name === 'string' && h.name) ||
      (typeof h.hostName === 'string' && h.hostName) ||
      'host';
    // Carry the discovered signaling endpoint through so connect() can reach a
    // host living on another LAN machine (its own signaling server), instead of
    // joining the code against this AI server's default signalingUrl.
    const signalingUrl = signalingUrlForDiscoveredHost(h);
    return signalingUrl ? { code, name, signalingUrl } : { code, name };
  }

  /**
   * Resolve the signaling endpoint to connect a given code against. Precedence:
   *   1. an explicit `endpoint` passed to {@link connect} (caller override),
   *   2. the endpoint discovered for this code in the last {@link listHosts}
   *      (so `connect(code)` alone reaches a host on another LAN machine), then
   *   3. this AI server's configured {@link signalingUrl} (manual codes).
   */
  private resolveSignalingUrl(code: string, endpoint?: string): string {
    const explicit = endpoint?.trim();
    if (explicit) return explicit;
    return this.discoveredEndpoints.get(code) ?? this.signalingUrl;
  }

  /**
   * Connect to a host by its session code as a viewer. Idempotent for the same
   * code AT THE SAME ENDPOINT; reconnecting to a different code OR a different
   * resolved endpoint disconnects first and reconnects.
   *
   * `endpoint` (the host's signaling WebSocket URL, e.g. `ws://192.168.1.50:8787`)
   * is optional. When omitted, a code discovered via the last {@link listHosts}
   * is joined against the endpoint it was advertised at; an unknown (manually
   * entered) code falls back to the configured {@link SessionOptions.signalingUrl}.
   *
   * Idempotency keys on BOTH the code AND the resolved endpoint: a numeric code
   * is not globally unique across signaling servers (code collisions, or an
   * explicit endpoint override), so a later `connect(code, otherEndpoint)` must
   * switch hosts rather than silently no-op against the old one.
   */
  async connect(code: string, endpoint?: string): Promise<void> {
    if (!isValidSessionCode(code)) {
      throw new Error(`Invalid session code "${code}": expected 6–9 digits.`);
    }

    // Resolve the target endpoint FIRST (explicit override / discovered / default)
    // so idempotency compares the actual server this connect would join against —
    // not just the code. Same precedence as a fresh connect uses below.
    const signalingUrl = this.resolveSignalingUrl(code, endpoint);

    // Short-circuit ONLY when BOTH the code and the resolved endpoint already
    // match the live session. A matching code at a DIFFERENT endpoint falls
    // through to disconnect+reconnect so control/capture target the new host.
    if (this.connected && this.connectedCode === code && this.connectedEndpoint === signalingUrl)
      return;
    if (this.connected) this.disconnect();

    const ctor = await this.ensureRtc();

    const signaling: SessionSignaling = this.opts.signalingClientFactory
      ? this.opts.signalingClientFactory(signalingUrl)
      : new SignalingClient(signalingUrl);
    await signaling.connect();

    // Reset any stale server-distributed list from a previous connect so a join
    // ack that carries no list leaves us at the LAN-only default (not the prior
    // host's servers). The explicit override (iceOverride) is constructor-fixed.
    this.serverIceServers = null;

    let peer: Peer | null = null;
    try {
      // Send the join, then WAIT for the server's acknowledgement BEFORE building
      // the Peer. The signaling server replies `joined` on success (carrying the
      // server-distributed STUN/TURN list we capture into `serverIceServers`) or
      // `error` (e.g. `no-such-session`) when the code names no live room. Without
      // this handshake, connect() would resolve optimistically against an unjoined
      // socket, so subsequent control calls would silently target nothing.
      await this.awaitJoinAck(signaling, code, () => {
        signaling.join({
          code,
          role: 'viewer',
          name: this.opts.viewerName ?? 'streamscreen-ai',
        });
      });

      // Build + start the Peer ONLY AFTER the join ack so it negotiates against
      // the SAME ICE config the server distributed to both peers: an explicit
      // override (opts.iceServers / STREAMSCREEN_ICE_SERVERS) wins, else the
      // server-distributed list, else LAN-only []. The host emits its offer only
      // after observing our `peer-joined` — which the server routes only AFTER
      // acknowledging our join — so the peer's `offer` handler is wired in time.
      peer = new Peer({
        role: 'viewer',
        signaling: signaling as unknown as SignalingClient,
        iceServers: this.effectiveIceServers,
        rtcPeerConnection: ctor,
      });
      peer.on('track', (track: unknown) => {
        this.installFrameSink(track);
      });
      peer.onControl((m) => this.handleControl(m));
      await peer.start();
    } catch (err) {
      // Tear down the half-open connection so the session stays in a clean,
      // disconnected state (connectedCode is never set on failure).
      try {
        peer?.close();
      } catch {
        /* best-effort */
      }
      try {
        signaling.close();
      } catch {
        /* best-effort */
      }
      throw err;
    }

    this.signaling = signaling as unknown as SignalingClient;
    this.peer = peer;
    this.connectedCode = code;
    this.connectedEndpoint = signalingUrl;
  }

  /**
   * Resolve when the signaling server acknowledges our join with `joined`; reject
   * if it replies `error` (e.g. `no-such-session`) or if no acknowledgement
   * arrives within the handshake timeout. The `join` itself is sent via `sendJoin`
   * AFTER the listeners are wired so the reply can never be missed. This is a
   * connect-time handshake only — it imposes no session duration limit.
   */
  private awaitJoinAck(
    signaling: SessionSignaling,
    code: string,
    sendJoin: () => void,
  ): Promise<void> {
    const timeoutMs = this.opts.joinTimeoutMs ?? JOIN_ACK_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onJoined = (m: SignalAck): void => {
        // Capture the server-distributed ICE list (if any) so the Peer is built
        // to negotiate against the SAME STUN/TURN config as the host. Validate
        // defensively with core isIceServerList: a malformed or absent field is
        // ignored (leaves serverIceServers null -> LAN-only unless overridden).
        if (isIceServerList(m.iceServers)) {
          this.serverIceServers = m.iceServers.map((s) => ({ ...s }));
        }
        finish();
      };
      const onError = (m: SignalAck): void =>
        finish(new JoinRejectedError(m.message ?? 'signaling join rejected'));
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
            new JoinRejectedError(
              `Timed out after ${timeoutMs}ms waiting for the signaling server to ` +
                `acknowledge join for code "${code}".`,
            ),
          ),
        timeoutMs,
      );
      signaling.on('joined', onJoined);
      signaling.on('error', onError);
      sendJoin();
    });
  }

  /** Disconnect from the current session. No-op if not connected. */
  disconnect(): void {
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    if (this.signaling) {
      this.signaling.close();
      this.signaling = null;
    }
    if (this.videoSink) {
      // Stop the native sink so its native resources are released; a reconnect
      // installs a fresh one. Guard the call since `stop` is runtime-specific.
      try {
        this.videoSink.stop?.();
      } catch {
        /* best-effort: never let sink teardown break disconnect */
      }
      this.videoSink.onframe = null;
      this.videoSink = null;
    }
    this.connectedCode = null;
    this.connectedEndpoint = null;
    this.lastFrame = null;
    this.frameSink = null;
    this.lastMonitors = null;
    // Reject any list_monitors calls still awaiting a reply.
    const waiters = this.monitorWaiters;
    this.monitorWaiters = [];
    for (const w of waiters) w([]);
  }

  /**
   * Capture the latest remote frame as encoded image bytes (PNG). Requires an
   * active connection that has produced at least one frame.
   */
  async screenshot(): Promise<CapturedFrame> {
    this.assertConnected();
    if (!this.lastFrame) {
      throw new Error(
        'No frame captured yet: the remote video track has not delivered a frame. ' +
          'Wait briefly after connect() before taking a screenshot.',
      );
    }
    return this.lastFrame;
  }

  /** Move the remote cursor to a normalized (x,y) in [0,1]. */
  moveMouse(x: number, y: number): void {
    this.send(moveMouseEvent(x, y));
  }

  /** Click `button` (0=left,1=middle,2=right) at normalized (x,y). */
  click(x: number, y: number, button?: number): void {
    for (const e of clickEvents(x, y, button)) this.send(e);
  }

  /** Type a string on the remote machine. */
  typeText(text: string): void {
    for (const e of typeTextEvents(text)) this.send(e);
  }

  /** Press and release a key with optional modifier bitflags. */
  pressKey(key: string, mods?: number): void {
    for (const e of pressKeyEvents(key, mods)) this.send(e);
  }

  /** Fetch live connection-quality stats. */
  async getStats(): Promise<AdaptiveStats> {
    this.assertConnected();
    return this.peer!.getStats();
  }

  /**
   * Ask the host to enumerate its displays and return the reported list. Sends a
   * `request-monitors` control message and resolves when the host replies with a
   * `monitors` message (or after `timeoutMs`, with the last-known list or []).
   */
  async listMonitors(timeoutMs = 2000): Promise<MonitorInfo[]> {
    this.assertConnected();
    return await new Promise<MonitorInfo[]>((resolve) => {
      let settled = false;
      const done = (list: MonitorInfo[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(list);
      };
      const timer = setTimeout(() => {
        // Drop our waiter and resolve with whatever we last knew.
        this.monitorWaiters = this.monitorWaiters.filter((w) => w !== done);
        done(this.lastMonitors ?? []);
      }, timeoutMs);
      this.monitorWaiters.push(done);
      this.peer!.sendControl({ t: 'request-monitors' });
    });
  }

  /** Switch the active streamed monitor to `id` (from {@link listMonitors}). */
  switchMonitor(id: string): void {
    this.assertConnected();
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Missing or invalid monitor id.');
    }
    this.peer!.sendControl({ t: 'switch-monitor', id });
  }

  /** Send a chat message to the host operator. */
  sendChat(text: string): void {
    this.assertConnected();
    if (typeof text !== 'string') throw new Error('Missing or invalid chat text.');
    this.peer!.sendControl({ t: 'chat', text, ts: Date.now() });
  }

  /** Set the streaming quality preset (validated). */
  setQuality(preset: unknown): QualityPreset {
    this.assertConnected();
    const p = toQualityPreset(preset);
    this.peer!.sendControl({ t: 'quality', preset: p });
    return p;
  }

  /** Press an arbitrary modifier+key chord (e.g. ['ctrl','alt','delete']). */
  sendKeys(keys: unknown): void {
    for (const e of sendKeysEvents(keys)) this.send(e);
  }

  /** Press a named special combo (e.g. 'ctrl+alt+del'). */
  pressCombo(combo: unknown): void {
    for (const e of comboEvents(combo)) this.send(e);
  }

  /**
   * Inject a fake peer and mark the session connected. FOR TESTS ONLY: lets a
   * test exercise the real control/dispatch path (the `connected` guard plus
   * `peer.sendInput`/`peer.sendControl`) without a WebRTC runtime or signaling.
   */
  attachTestPeer(peer: SessionPeer, code = '123456'): void {
    this.peer = peer;
    this.connectedCode = code;
    peer.onControl((m) => this.handleControl(m));
  }

  /** Route an inbound control message (monitor replies, etc.). */
  private handleControl(m: ControlMessage): void {
    if (m.t === 'monitors') {
      this.lastMonitors = m.list;
      const waiters = this.monitorWaiters;
      this.monitorWaiters = [];
      for (const w of waiters) w(m.list);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private send(e: InputEvent): void {
    this.assertConnected();
    this.peer!.sendInput(e);
  }

  private assertConnected(): void {
    if (!this.connected) throw new NotConnectedError();
  }

  /** Resolve (and memoize) the RTCPeerConnection constructor. */
  private async ensureRtc(): Promise<typeof RTCPeerConnection> {
    if (this.rtcCtor) return this.rtcCtor;
    const resolved = await resolveNodeRtc();
    if (!resolved) throw new WebRtcUnavailableError();
    this.rtcCtor = resolved;
    return resolved;
  }

  /**
   * Wire a frame sink onto the inbound remote video track when the WebRTC
   * runtime supports raw frame access (`@roamhq/wrtc` exposes
   * `RTCVideoSink`). We pull I420 frames, but since image encoding (I420→PNG)
   * is runtime-specific we store the most recent raw frame's encoded form when a
   * sink already yields encoded data. If the runtime offers no sink, screenshots
   * remain unavailable until a frame arrives via an injected sink.
   */
  private installFrameSink(track: unknown): void {
    // Allow an externally-installed sink (e.g. injected in tests) to win.
    this.frameSink = (frame) => {
      this.lastFrame = frame;
    };
    // @roamhq/wrtc nonstandard: nonstandard.RTCVideoSink. We probe for it
    // lazily; if unavailable, frames must be provided via pushFrame().
    void this.tryNativeSink(track);
  }

  private async tryNativeSink(track: unknown): Promise<void> {
    try {
      const wrtc = (await import('@roamhq/wrtc')) as unknown as {
        nonstandard?: { RTCVideoSink?: NativeVideoSinkCtor };
      };
      const Sink = wrtc.nonstandard?.RTCVideoSink;
      if (!Sink) return;
      const sink = new Sink(track);
      sink.onframe = (e) => {
        // Store the raw I420 frame wrapped as a CapturedFrame. Consumers that
        // need PNG should encode it; we expose the raw bytes with a precise
        // mime type so no information is lost.
        const png = encodeI420ToPng(e.frame);
        if (png) this.pushFrame({ data: png, mimeType: 'image/png' });
      };
      // Retain the sink on the instance for the session's lifetime. Without this
      // the sink (and its onframe callback) becomes GC-eligible once this method
      // returns, so frame delivery can silently stop even though the connection
      // is still up. disconnect() stops + clears it.
      this.videoSink = sink;
    } catch {
      /* native sink unavailable; frames may be pushed externally */
    }
  }

  /**
   * Inject an already-encoded frame as the current screenshot source. Used by
   * tests and by alternative capture pipelines that decode video out-of-band.
   */
  pushFrame(frame: CapturedFrame): void {
    if (this.frameSink) this.frameSink(frame);
    else this.lastFrame = frame;
  }
}

/**
 * Encode a raw I420 video frame to a PNG buffer. We perform the YUV→RGB
 * conversion ourselves and emit a minimal (uncompressed-IDAT) PNG so this needs
 * no native image library. Returns `null` if the frame is malformed.
 */
function encodeI420ToPng(frame: {
  width: number;
  height: number;
  data: Uint8Array;
}): Buffer | null {
  const { width, height, data } = frame;
  if (width <= 0 || height <= 0) return null;
  const ySize = width * height;
  const cSize = (width >> 1) * (height >> 1);
  if (data.length < ySize + 2 * cSize) return null;

  const uOff = ySize;
  const vOff = ySize + cSize;
  const cw = width >> 1;

  // RGBA raster with a leading filter byte per scanline (PNG filter type 0).
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let j = 0; j < height; j++) {
    raw[j * stride] = 0; // filter: none
    const cj = j >> 1;
    for (let i = 0; i < width; i++) {
      const ci = i >> 1;
      const Y = data[j * width + i];
      const U = data[uOff + cj * cw + ci] - 128;
      const V = data[vOff + cj * cw + ci] - 128;
      const r = clampByte(Y + 1.402 * V);
      const g = clampByte(Y - 0.344136 * U - 0.714136 * V);
      const b = clampByte(Y + 1.772 * U);
      const p = j * stride + 1 + i * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  return buildPng(width, height, raw);
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

/** Build a PNG from a filtered RGBA raster using zlib deflate. */
function buildPng(width: number, height: number, filtered: Buffer): Buffer {
  const idat = deflateSync(filtered);

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** Standard CRC-32 (PNG polynomial). */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
