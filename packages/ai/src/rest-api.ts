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
 *   GET  /health                    -> { ok, service, connected, code, webrtc, ocr }
 *
 * A node WebRTC runtime is OPTIONAL; if absent, control/capture routes respond
 * 503 with a clear "requires native webrtc runtime" message. The server itself
 * always starts. Always free — no auth, usage counters, or time limits.
 */

import express, { type Express, type Request, type Response } from 'express';
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

/**
 * Build the Express app wiring every REST route to a shared
 * {@link RemoteDesktopSession}. Does not call `listen` — the caller decides
 * when/where to bind (see {@link startRestApi}).
 */
export function createRestApi(opts: RestApiOptions = {}): {
  app: Express;
  session: RemoteDesktopSession;
} {
  const session = opts.session ?? new RemoteDesktopSession(opts.sessionOptions);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Permissive CORS for LAN automation tools on other origins.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  // GET /health — liveness + capability probe.
  app.get('/health', async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'streamscreen-ai',
      connected: session.connected,
      code: session.code,
      ocr: await isOcrAvailable(),
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

  // POST /api/connect { code } — connect.
  app.post('/api/connect', async (req: Request, res: Response) => {
    try {
      await session.connect(bodyString(req, 'code'));
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

  return { app, session };
}

/**
 * Build and start the REST API, listening on `port` (default 8788 or
 * `STREAMSCREEN_AI_PORT`). Resolves once bound.
 */
export async function startRestApi(
  opts: RestApiOptions = {},
): Promise<{ app: Express; session: RemoteDesktopSession; port: number; close: () => void }> {
  const built = createRestApi(opts);
  const port = Number(process.env.STREAMSCREEN_AI_PORT ?? 8788);
  return new Promise((resolve) => {
    const httpServer = built.app.listen(port, () => {
      resolve({ ...built, port, close: () => httpServer.close() });
    });
  });
}
