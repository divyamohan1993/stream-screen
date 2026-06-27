#!/usr/bin/env node
/**
 * @stream-screen/signaling — entrypoint.
 *
 * Boots the zero-config StreamScreen signaling stack:
 *   - one HTTP server hosting the tiny REST API,
 *   - the WebSocket signaling server attached to that same HTTP server (so
 *     REST + WS share a single port),
 *   - LAN mDNS discovery (best-effort; no-ops if multicast is unavailable).
 *
 * Configure the port with env STREAMSCREEN_PORT (default 8787) and the
 * advertised host name with env STREAMSCREEN_HOST_NAME (default: the machine
 * hostname). On start it logs the reachable LAN URL(s).
 *
 * DISCOVERY IS TRUTHFUL: it advertises the codes of ACTUAL live host rooms
 * (re-synced from the signaling server whenever a host joins/leaves), never a
 * placeholder code minted at startup with no host behind it. With no live host
 * sessions, nothing connectable is advertised — so every discovered code maps
 * to a joinable room.
 *
 * ALWAYS FREE / UNLIMITED: nothing here imposes time limits, usage counters, or
 * licensing. Sessions last as long as their sockets stay open.
 */

import { hostname } from 'node:os';
import { networkInterfaces } from 'node:os';
import { SignalingServer } from './server.js';
import { Discovery } from './discovery.js';
import { createRestServer } from './rest.js';

export { SignalingServer, generateCode } from './server.js';
export type { SignalingServerOptions } from './server.js';
export { Discovery, serviceToHost, SERVICE_TYPE, SERVICE_PROTOCOL } from './discovery.js';
export type {
  AdvertiseOptions,
  BrowseOptions,
  DiscoveredHost,
} from './discovery.js';
export { createRestServer } from './rest.js';
export type { RestDeps } from './rest.js';

export interface StreamScreenSignaling {
  signaling: SignalingServer;
  discovery: Discovery;
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  hostName?: string;
  /** Disable mDNS advertisement/discovery entirely. */
  disableDiscovery?: boolean;
  /**
   * Trust a reverse proxy's `X-Forwarded-For` header for the join-failure
   * throttle. Off by default (direct LAN deployments). When unset, falls back
   * to the `STREAMSCREEN_TRUST_PROXY` env flag.
   */
  trustProxy?: boolean;
}

/**
 * Start the full signaling stack and resolve once it is listening.
 * Intended for both `npm start` (via the module's bottom block) and embedding.
 */
export async function start(opts: StartOptions = {}): Promise<StreamScreenSignaling> {
  const port = opts.port ?? Number(process.env.STREAMSCREEN_PORT ?? 8787);
  const hostName =
    opts.hostName ?? process.env.STREAMSCREEN_HOST_NAME ?? hostname() ?? 'streamscreen-host';

  const discovery = new Discovery();

  // Optional hardening config (all opt-in; zero-config defaults stay friendly):
  //   STREAMSCREEN_ALLOWED_ORIGINS  comma-separated browser Origin allowlist
  //                                 (use '*' to allow any — explicit opt-out).
  //   STREAMSCREEN_TOKEN            CANONICAL bearer token that unlocks raw codes
  //                                 on /api/sessions; without it that endpoint is
  //                                 always redacted. This is the SAME env var the
  //                                 AI client (packages/ai) reads to authenticate
  //                                 its /api/sessions fallback, so list_hosts gets
  //                                 un-redacted, joinable codes in the documented
  //                                 single-token setup.
  //   STREAMSCREEN_REST_TOKEN      backward-compatible ALIAS for the above. When
  //                                 both are set, STREAMSCREEN_TOKEN wins.
  const allowedOrigins = parseList(process.env.STREAMSCREEN_ALLOWED_ORIGINS);
  // Prefer the canonical STREAMSCREEN_TOKEN (matches the AI client + docs); fall
  // back to the legacy STREAMSCREEN_REST_TOKEN alias so existing deployments that
  // only set the old name keep working.
  const restToken =
    process.env.STREAMSCREEN_TOKEN || process.env.STREAMSCREEN_REST_TOKEN || undefined;
  // STREAMSCREEN_TRUST_PROXY: opt in to honoring X-Forwarded-For for the
  // join-failure throttle (only when behind a TRUSTED reverse proxy). Off by
  // default so direct LAN clients cannot spoof XFF to evade the throttle.
  const trustProxy = opts.trustProxy ?? parseBool(process.env.STREAMSCREEN_TRUST_PROXY);

  // Build HTTP (REST) first, then attach WS to it so they share a port.
  const http = createRestServer({
    listSessions: () => signaling.listSessions(),
    mintCode: () => signaling.mintCode(),
    discovery,
    allowedOrigins,
    token: restToken,
  });
  const signaling = new SignalingServer({ server: http, allowedOrigins, trustProxy });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const boundPort = addressPort(http) ?? port;

  // TRUTHFUL DISCOVERY: advertise the codes of ACTUAL live host rooms, not a
  // placeholder code minted at startup with no host behind it. Discovery
  // re-syncs from the signaling server's live sessions whenever a host
  // joins/leaves, so every advertised (and thus discoverable) code maps to a
  // joinable room. With no live host sessions, nothing connectable is
  // advertised. Multiple concurrent hosts each get their own advertisement.
  let onSessionsChanged: ((sessions: ReturnType<SignalingServer['listSessions']>) => void) | undefined;
  if (!opts.disableDiscovery) {
    const sync = (sessions: ReturnType<SignalingServer['listSessions']>): void => {
      const live = sessions.map((s) => ({
        code: s.code,
        hostName: s.hostName?.trim() || hostName,
      }));
      const ok = discovery.syncSessions(live, boundPort);
      if (!ok) {
        console.warn(
          '[signaling] mDNS unavailable; LAN auto-discovery disabled (manual code entry still works).',
        );
      }
    };
    onSessionsChanged = sync;
    signaling.on('sessions-changed', sync);
    // Initial sync (typically no live hosts yet ⇒ advertises nothing joinable).
    sync(signaling.listSessions());
  }

  logUrls(boundPort);

  return {
    signaling,
    discovery,
    port: boundPort,
    async close() {
      if (onSessionsChanged) signaling.off('sessions-changed', onSessionsChanged);
      discovery.destroy();
      await signaling.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Parse a comma-separated env list into a trimmed string[] (undefined if empty). */
function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse a boolean-ish env flag. Truthy values: `1`, `true`, `yes`, `on`
 * (case-insensitive). Everything else (including unset) is false.
 */
function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function addressPort(server: import('node:http').Server): number | undefined {
  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return undefined;
}

/** Log every reachable LAN URL so the user can pick the right interface. */
function logUrls(port: number): void {
  const ifaces = networkInterfaces();
  const addrs: string[] = ['127.0.0.1'];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const ni of list) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log('[signaling] StreamScreen signaling server ready (always free, no time limits).');
  for (const a of addrs) {
    console.log(`[signaling]   http://${a}:${port}/health   ws://${a}:${port}`);
  }
}

/**
 * Run directly (`node dist/index.js` / `tsx src/index.ts`) but stay importable
 * for tests/embedding. Compares the resolved entry module URL to this file.
 */
const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isMain) {
  start().catch((err) => {
    console.error('[signaling] failed to start:', err);
    process.exitCode = 1;
  });
}
