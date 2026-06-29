/**
 * Test web server for the e2e suite.
 *
 * Starts the real @stream-screen/signaling stack (WebSocket SDP/ICE relay +
 * the REST health/list API) and a tiny static file server for the fixture
 * pages, all on one HTTP port so the Playwright pages can `fetch`/`ws` the same
 * origin. mDNS discovery is disabled (multicast is unavailable / irrelevant in
 * CI), and the keepalive heartbeat is off so it can't interfere with the test.
 *
 *   GET  /health, /api/...   -> the real signaling REST app
 *   WS   ws://host:PORT       -> the real signaling relay
 *   GET  /<file>             -> static fixture from e2e/fixtures
 *
 * Port comes from env PORT (default 8787). Logs "listening" once ready so the
 * Playwright webServer can detect readiness via GET /health.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, normalize, extname, join } from 'node:path';
import { SignalingServer, createRestServer, Discovery } from '@stream-screen/signaling';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../fixtures');
const port = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const discovery = new Discovery();

// The real REST app (a node http.Server we only borrow the request handler from).
const restApp = createRestServer({
  listSessions: () => signaling.listSessions(),
  mintCode: () => signaling.mintCode(),
  discovery,
  discoverTimeoutMs: 200,
});

const REST_PREFIXES = ['/health', '/api/'];
function isRestPath(pathname) {
  return REST_PREFIXES.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p));
}

async function serveStatic(req, res) {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/host-page.html';

    const filePath = normalize(join(fixturesDir, pathname));
    if (!filePath.startsWith(fixturesDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const http = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://localhost:${port}`).pathname;
  if (isRestPath(pathname)) {
    // Delegate to the real REST app's request handler.
    restApp.emit('request', req, res);
    return;
  }
  void serveStatic(req, res);
});

// Attach the real signaling WebSocket server to the same HTTP server.
const signaling = new SignalingServer({ server: http, heartbeatMs: 0 });

http.listen(port, () => {
  console.log(`[e2e-server] listening on http://localhost:${port} (fixtures + signaling + REST)`);
});

function shutdown() {
  discovery.destroy();
  void signaling.close().finally(() => http.close(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
