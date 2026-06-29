/**
 * StreamScreen REST API — a deliberately tiny surface built on the node `http`
 * module (no framework dependency). It exposes read-only session/discovery
 * info plus a code-minting helper, and serves NOTHING else.
 *
 * Endpoints:
 *   GET  /health         -> { ok, service, sessions, uptimeMs, discovery }
 *   GET  /api/sessions   -> SessionInfo[]   (active rooms on this server)
 *   GET  /api/discover   -> DiscoveredHost[] (mDNS browse of the LAN)
 *   GET  /api/ice        -> { iceServers }  (operator STUN/TURN config; [] = LAN-only)
 *   POST /api/code       -> { code }        (mint a fresh session code)
 *
 * It is designed to share a single HTTP server with the WebSocket signaling
 * server so both live on one port (env STREAMSCREEN_PORT).
 *
 * SECURITY: the session code is the ONLY credential that gates a session, so
 * this surface must not publish it to untrusted callers.
 *   - `/api/sessions` REDACTS the raw `code` by default (masks all but the last
 *     two digits), so an unauthenticated cross-origin caller can no longer
 *     scrape live session secrets. Full codes are only returned when a caller
 *     presents the configured bearer `token`.
 *   - CORS is an explicit ORIGIN ALLOWLIST, not the old wildcard. WebSocket
 *     handshakes ignore CORS (that is enforced separately in the WS server's
 *     Origin check), but for the REST surface an allowlist keeps arbitrary web
 *     pages from reading these responses. `['*']` re-enables wildcard CORS as an
 *     explicit opt-out.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionInfo } from '@stream-screen/core';
import type { Discovery, DiscoveredHost } from './discovery.js';

export interface RestDeps {
  /** Snapshot of currently active sessions on this signaling server. */
  listSessions: () => SessionInfo[];
  /** Mint a fresh, unused session code. */
  mintCode: () => string;
  /** LAN discovery façade used by /api/discover. */
  discovery: Discovery;
  /**
   * Operator-configured ICE servers exposed at `GET /api/ice` for clients that
   * prefer to fetch the STUN/TURN config over REST instead of reading it off the
   * WebSocket `joined` ack. The SAME list the signaling server distributes to
   * both peers. Omitted/empty => `[]` => LAN-only default (unchanged behavior).
   * This is read-only, non-secret config (no session codes), so it is returned
   * to any caller subject only to the existing CORS policy.
   */
  iceServers?: () => RTCIceServer[];
  /** Browse timeout for /api/discover, in ms. */
  discoverTimeoutMs?: number;
  /**
   * CORS Origin allowlist for the REST surface.
   *   - `undefined` / empty -> NO `Access-Control-Allow-Origin` header is sent
   *     (same-origin only; cross-origin browser reads are blocked by the SOP).
   *   - `['*']`             -> wildcard CORS (explicit opt-out).
   *   - `['http://host:5173', ...]` -> reflect only these exact Origins.
   */
  allowedOrigins?: string[];
  /**
   * Optional bearer token. When set, callers presenting it (via the
   * `Authorization: Bearer <token>` header or `?token=` query) receive
   * un-redacted session codes from `/api/sessions`. When unset, `/api/sessions`
   * is always redacted. `/api/code` and `/api/discover` remain open so the
   * zero-config viewer flow (mint a code, browse mDNS) keeps working.
   */
  token?: string;
}

const startedAt = Date.now();

/**
 * Build (but do not listen on) the HTTP server. The caller decides when/where
 * to listen so the WS server can be attached to the same instance first.
 */
export function createRestServer(deps: RestDeps): Server {
  return createServer((req, res) => handle(req, res, deps));
}

function handle(req: IncomingMessage, res: ServerResponse, deps: RestDeps): void {
  applyCors(req, res, deps.allowedOrigins);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/health' || path === '/')) {
    sendJson(res, 200, {
      ok: true,
      service: 'streamscreen-signaling',
      sessions: deps.listSessions().length,
      uptimeMs: Date.now() - startedAt,
      discovery: deps.discovery.available,
    });
    return;
  }

  if (method === 'GET' && path === '/api/sessions') {
    // Only an authenticated caller may see raw codes; everyone else gets a
    // redacted view so the open endpoint cannot be used to scrape live secrets.
    const authed = isAuthorized(req, url, deps.token);
    const sessions = deps.listSessions();
    sendJson(res, 200, authed ? sessions : sessions.map(redactSession));
    return;
  }

  if (method === 'GET' && path === '/api/discover') {
    deps.discovery
      .browse({ timeoutMs: deps.discoverTimeoutMs ?? 1500 })
      .then((hosts: DiscoveredHost[]) => sendJson(res, 200, hosts))
      .catch(() => sendJson(res, 200, []));
    return;
  }

  if (method === 'GET' && path === '/api/ice') {
    // Read-only STUN/TURN config so a client can match the peers' ICE servers.
    // Not a secret (no session code), so no token gate — just the CORS policy.
    sendJson(res, 200, { iceServers: deps.iceServers ? deps.iceServers() : [] });
    return;
  }

  if (method === 'POST' && path === '/api/code') {
    sendJson(res, 200, { code: deps.mintCode() });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not-found' });
}

/**
 * Apply the configured CORS policy. Default (no allowlist) sends no
 * `Access-Control-Allow-Origin`, so browsers enforce same-origin-only. `['*']`
 * is an explicit wildcard opt-out; an allowlist reflects only matching Origins.
 */
function applyCors(req: IncomingMessage, res: ServerResponse, allowed?: string[]): void {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (!allowed || allowed.length === 0) return;
  if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

/** Mask all but the last two digits of a session code, e.g. "******23". */
function redactCode(code: string): string {
  if (code.length <= 2) return '*'.repeat(code.length);
  return '*'.repeat(code.length - 2) + code.slice(-2);
}

function redactSession(s: SessionInfo): SessionInfo {
  return { ...s, code: redactCode(s.code) };
}

/** Constant-time bearer-token check from the Authorization header or `?token=`. */
function isAuthorized(req: IncomingMessage, url: URL, token?: string): boolean {
  if (!token) return false;
  const header = req.headers.authorization;
  let presented: string | undefined;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    presented = header.slice('Bearer '.length).trim();
  } else {
    presented = url.searchParams.get('token') ?? undefined;
  }
  if (!presented) return false;
  return safeEqual(presented, token);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
