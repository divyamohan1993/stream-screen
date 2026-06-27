/**
 * StreamScreen AI REST API — an Express server mirroring every MCP tool so
 * non-MCP automation can drive the same remote desktop. Routes are generated
 * from the shared {@link TOOL_DEFINITIONS} registry, so REST and MCP can never
 * drift apart.
 *
 * Routes (all JSON unless noted):
 *   GET  /api/hosts                 -> HostEntry[]                 (list_hosts)
 *   POST /api/connect   { code }    -> { connected, code }         (connect)
 *   POST /api/disconnect            -> { connected: false }        (disconnect)
 *   GET  /api/screenshot            -> image/png (raw bytes)       (screenshot)
 *   GET  /api/ocr                   -> { text }                    (ocr_screen)
 *   POST /api/move      { x, y }    -> { ok: true }                (move_mouse)
 *   POST /api/click     { x, y, button? } -> { ok: true }          (click)
 *   POST /api/type      { text }    -> { ok: true }                (type_text)
 *   POST /api/key       { key, mods? }    -> { ok: true }          (press_key)
 *   GET  /api/stats                 -> AdaptiveStats               (get_stats)
 *   GET  /api/monitors              -> MonitorInfo[]               (list_monitors)
 *   POST /api/monitor   { id }      -> { ok: true }                (switch_monitor)
 *   POST /api/chat      { text }    -> { ok: true }                (send_chat)
 *   POST /api/quality   { preset }  -> { ok, preset }              (set_quality)
 *   POST /api/keys      { keys[] }  -> { ok: true }                (send_keys)
 *   POST /api/combo     { combo }   -> { ok: true }                (press_combo)
 *   GET  /health                    -> { ok, service, connected, code, ocr, authRequired }
 *
 * A node WebRTC runtime is OPTIONAL; if absent, control/capture routes respond
 * 503 with a clear "requires native webrtc runtime" message. The server itself
 * always starts. Always free — no usage counters, no time limits, no bitrate caps.
 *
 * SECURITY. This API can fully drive a remote desktop (type, click, screenshot),
 * so it is NOT open by default:
 *  - Every `/api/*` route requires a bearer token. Supply it via the
 *    `STREAMSCREEN_AI_TOKEN` env var; if unset, a random token is generated at
 *    startup and printed to stderr. Clients send `Authorization: Bearer <token>`
 *    (or `?token=<token>`). `/health` is the only unauthenticated route.
 *  - CORS is NOT wildcard. Cross-origin browser requests are rejected unless the
 *    request Origin is in the `STREAMSCREEN_AI_ALLOWED_ORIGINS` allowlist
 *    (comma-separated). With no allowlist, no `Access-Control-Allow-Origin`
 *    header is sent, so a drive-by web page cannot read responses, and the
 *    bearer-token requirement blocks the simple-request CSRF write path.
 * Set `STREAMSCREEN_AI_TOKEN=""` AND `requireAuth:false` only for trusted,
 * already-isolated test setups.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  RemoteDesktopSession,
  WebRtcUnavailableError,
  type SessionOptions,
} from './session.js';
import { OcrUnavailableError, isOcrAvailable, ocrImage } from './ocr.js';

/** Options for {@link createRestApi}. */
export interface RestApiOptions {
  session?: RemoteDesktopSession;
  sessionOptions?: SessionOptions;
  /**
   * Bearer token required on every `/api/*` request. Defaults to
   * `STREAMSCREEN_AI_TOKEN`, else a random token generated and logged at startup.
   */
  authToken?: string;
  /**
   * Whether to enforce bearer-token auth on `/api/*`. Defaults to `true`. Only
   * disable for trusted, isolated test setups.
   */
  requireAuth?: boolean;
  /**
   * Allowed CORS origins (exact-match). Defaults to
   * `STREAMSCREEN_AI_ALLOWED_ORIGINS` (comma-separated) or none. When empty, no
   * cross-origin browser access is granted.
   */
  allowedOrigins?: string[];
}

/** Constant-time string comparison that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a presented bearer token from the Authorization header or ?token=. */
function presentedToken(req: Request): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const q = req.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/** Map an error to an HTTP status + message body. */
function errorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof WebRtcUnavailableError || err instanceof OcrUnavailableError) {
    return { status: 503, message: err.message };
  }
  return { status: 400, message: err instanceof Error ? err.message : String(err) };
}

/** Send a JSON error response derived from a thrown error. */
function sendError(res: Response, err: unknown): void {
  const { status, message } = errorStatus(err);
  res.status(status).json({ error: message });
}

/** Parse a required numeric body field. */
function bodyNumber(req: Request, key: string): number {
  const v = (req.body ?? {})[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Missing or invalid number field "${key}".`);
  return n;
}

/** Parse a required string body field. */
function bodyString(req: Request, key: string): string {
  const v = (req.body ?? {})[key];
  if (typeof v !== 'string') throw new Error(`Missing or invalid string field "${key}".`);
  return v;
}

/** Read an optional string body field; undefined when absent or empty. */
function bodyOptString(req: Request, key: string): string | undefined {
  const v = (req.body ?? {})[key];
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v;
}

/**
 * Build the Express app wiring every REST route to a shared
 * {@link RemoteDesktopSession}. Does not call `listen` — the caller decides
 * when/where to bind (see {@link startRestApi}).
 */
export function createRestApi(opts: RestApiOptions = {}): {
  app: Express;
  session: RemoteDesktopSession;
  /** The bearer token enforced on `/api/*` (empty string when auth disabled). */
  authToken: string;
} {
  const session = opts.session ?? new RemoteDesktopSession(opts.sessionOptions);
  const requireAuth = opts.requireAuth ?? true;
  // Resolve the bearer token: explicit option > env > freshly generated.
  let authToken = opts.authToken ?? process.env.STREAMSCREEN_AI_TOKEN ?? '';
  if (requireAuth && authToken.length === 0) {
    authToken = randomBytes(24).toString('base64url');
    // eslint-disable-next-line no-console
    console.error(
      `[streamscreen-ai] No STREAMSCREEN_AI_TOKEN set; generated one for this run:\n` +
        `[streamscreen-ai]   ${authToken}\n` +
        `[streamscreen-ai] Clients must send "Authorization: Bearer <token>".`,
    );
  }

  const allowedOrigins =
    opts.allowedOrigins ??
    (process.env.STREAMSCREEN_AI_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const allowedSet = new Set(allowedOrigins);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS: NEVER wildcard. Reflect only explicitly-allowlisted origins so a
  // drive-by web page on a random origin cannot read responses. When no
  // allowlist is configured, no ACAO header is emitted at all.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedSet.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  // Auth gate for every /api/* route. Constant-time token check; /health stays
  // open so liveness probes need no secret.
  const authGate = (req: Request, res: Response, next: NextFunction): void => {
    if (!requireAuth) {
      next();
      return;
    }
    const presented = presentedToken(req);
    if (presented !== null && safeEqual(presented, authToken)) {
      next();
      return;
    }
    res
      .status(401)
      .json({ error: 'Unauthorized: missing or invalid bearer token. See STREAMSCREEN_AI_TOKEN.' });
  };
  app.use('/api', authGate);

  // GET /health — liveness + capability probe.
  app.get('/health', async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'streamscreen-ai',
      connected: session.connected,
      code: session.code,
      ocr: await isOcrAvailable(),
      authRequired: requireAuth,
      // Free + unlimited: advertised so clients know there is no expiry.
      limits: { timeLimit: 'none', bitrateCap: 'none', cost: 'free' },
    });
  });

  // GET /api/hosts — list_hosts.
  app.get('/api/hosts', async (_req: Request, res: Response) => {
    try {
      res.json(await session.listHosts());
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/connect { code, signalingUrl? } — connect.
  app.post('/api/connect', async (req: Request, res: Response) => {
    try {
      await session.connect(bodyString(req, 'code'), bodyOptString(req, 'signalingUrl'));
      res.json({ connected: true, code: session.code });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/disconnect — disconnect.
  app.post('/api/disconnect', (_req: Request, res: Response) => {
    session.disconnect();
    res.json({ connected: false });
  });

  // GET /api/screenshot — screenshot (raw PNG bytes).
  app.get('/api/screenshot', async (_req: Request, res: Response) => {
    try {
      const frame = await session.screenshot();
      res.setHeader('Content-Type', frame.mimeType);
      res.send(frame.data);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/ocr — ocr_screen.
  app.get('/api/ocr', async (_req: Request, res: Response) => {
    try {
      const frame = await session.screenshot();
      const textOut = await ocrImage(frame.data);
      res.json({ text: textOut });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/move { x, y } — move_mouse.
  app.post('/api/move', (req: Request, res: Response) => {
    try {
      session.moveMouse(bodyNumber(req, 'x'), bodyNumber(req, 'y'));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/click { x, y, button? } — click.
  app.post('/api/click', (req: Request, res: Response) => {
    try {
      const button = (req.body ?? {}).button === undefined ? undefined : bodyNumber(req, 'button');
      session.click(bodyNumber(req, 'x'), bodyNumber(req, 'y'), button);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/type { text } — type_text.
  app.post('/api/type', (req: Request, res: Response) => {
    try {
      session.typeText(bodyString(req, 'text'));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/key { key, mods? } — press_key.
  app.post('/api/key', (req: Request, res: Response) => {
    try {
      const mods = (req.body ?? {}).mods === undefined ? undefined : bodyNumber(req, 'mods');
      session.pressKey(bodyString(req, 'key'), mods);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/stats — get_stats.
  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      res.json(await session.getStats());
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/monitors — list_monitors.
  app.get('/api/monitors', async (_req: Request, res: Response) => {
    try {
      res.json(await session.listMonitors());
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/monitor { id } — switch_monitor.
  app.post('/api/monitor', (req: Request, res: Response) => {
    try {
      session.switchMonitor(bodyString(req, 'id'));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/chat { text } — send_chat.
  app.post('/api/chat', (req: Request, res: Response) => {
    try {
      session.sendChat(bodyString(req, 'text'));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/quality { preset } — set_quality.
  app.post('/api/quality', (req: Request, res: Response) => {
    try {
      const preset = session.setQuality(bodyString(req, 'preset'));
      res.json({ ok: true, preset });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/keys { keys } — send_keys.
  app.post('/api/keys', (req: Request, res: Response) => {
    try {
      session.sendKeys((req.body ?? {}).keys);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/combo { combo } — press_combo.
  app.post('/api/combo', (req: Request, res: Response) => {
    try {
      session.pressCombo(bodyString(req, 'combo'));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  return { app, session, authToken };
}

/**
 * Build and start the REST API, listening on `port` (default 8788 or
 * `STREAMSCREEN_AI_PORT`). Resolves once bound.
 */
export async function startRestApi(opts: RestApiOptions = {}): Promise<{
  app: Express;
  session: RemoteDesktopSession;
  authToken: string;
  port: number;
  close: () => void;
}> {
  const built = createRestApi(opts);
  const port = Number(process.env.STREAMSCREEN_AI_PORT ?? 8788);
  return new Promise((resolve) => {
    const httpServer = built.app.listen(port, () => {
      resolve({ ...built, port, close: () => httpServer.close() });
    });
  });
}
