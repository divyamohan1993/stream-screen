/**
 * StreamScreen REST API — a deliberately tiny surface built on the node `http`
 * module (no framework dependency). It exposes read-only session/discovery
 * info plus a code-minting helper, and serves NOTHING else.
 *
 * Endpoints:
 *   GET  /health         -> { ok, service, sessions, uptimeMs, discovery }
 *   GET  /api/sessions   -> SessionInfo[]   (active rooms on this server)
 *   GET  /api/discover   -> DiscoveredHost[] (mDNS browse of the LAN)
 *   POST /api/code       -> { code }        (mint a fresh session code)
 *
 * It is designed to share a single HTTP server with the WebSocket signaling
 * server so both live on one port (env STREAMSCREEN_PORT).
 */

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
  /** Browse timeout for /api/discover, in ms. */
  discoverTimeoutMs?: number;
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
  // Permissive CORS: this is a LAN-only service intended to be reachable from
  // the viewer web app served on a different origin/port.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    sendJson(res, 200, deps.listSessions());
    return;
  }

  if (method === 'GET' && path === '/api/discover') {
    deps.discovery
      .browse({ timeoutMs: deps.discoverTimeoutMs ?? 1500 })
      .then((hosts: DiscoveredHost[]) => sendJson(res, 200, hosts))
      .catch(() => sendJson(res, 200, []));
    return;
  }

  if (method === 'POST' && path === '/api/code') {
    sendJson(res, 200, { code: deps.mintCode() });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not-found' });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
