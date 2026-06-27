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
export { Discovery, SERVICE_TYPE, SERVICE_PROTOCOL } from './discovery.js';
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

  // Build HTTP (REST) first, then attach WS to it so they share a port.
  const http = createRestServer({
    listSessions: () => signaling.listSessions(),
    mintCode: () => signaling.mintCode(),
    discovery,
  });
  const signaling = new SignalingServer({ server: http });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const boundPort = addressPort(http) ?? port;

  if (!opts.disableDiscovery) {
    const ok = discovery.advertise({ hostName, port: boundPort });
    if (!ok) {
      console.warn('[signaling] mDNS unavailable; LAN auto-discovery disabled (manual code entry still works).');
    }
  }

  logUrls(boundPort);

  return {
    signaling,
    discovery,
    port: boundPort,
    async close() {
      discovery.destroy();
      await signaling.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
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
