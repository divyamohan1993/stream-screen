#!/usr/bin/env node
/**
 * @stream-screen/ai — entry point.
 *
 * Starts the AI control layer in one of two modes:
 *   - MCP server over stdio (default) — for Model Context Protocol agents.
 *   - REST API (STREAMSCREEN_AI_MODE=rest) — for non-MCP automation.
 *
 * Relevant environment variables:
 *   STREAMSCREEN_AI_MODE        'rest' to run the REST API; anything else = MCP.
 *   STREAMSCREEN_SIGNALING_URL  signaling server URL (default ws://127.0.0.1:8787).
 *   STREAMSCREEN_AI_PORT        REST port (default 8788).
 *   STREAMSCREEN_AI_TOKEN       bearer token for REST /api/* (auto-generated if unset).
 *   STREAMSCREEN_AI_ALLOWED_ORIGINS  comma-separated CORS allowlist (default none).
 *
 * Always free, no time limits, no bitrate caps.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startMcpServer } from './mcp-server.js';
import { startRestApi } from './rest-api.js';

export * from './tools.js';
export * from './ocr.js';
export * from './session.js';
export * from './mcp-server.js';
export * from './rest-api.js';

/** Run the server selected by `STREAMSCREEN_AI_MODE`. */
export async function main(): Promise<void> {
  const mode = (process.env.STREAMSCREEN_AI_MODE ?? 'mcp').toLowerCase();
  if (mode === 'rest') {
    const { port } = await startRestApi();
    // eslint-disable-next-line no-console
    console.error(
      `[streamscreen-ai] REST API listening on http://0.0.0.0:${port} ` +
        `(bearer-token auth required on /api/*)`,
    );
  } else {
    await startMcpServer();
    // MCP uses stdout for protocol traffic; log to stderr only.
    // eslint-disable-next-line no-console
    console.error('[streamscreen-ai] MCP server ready on stdio');
  }
}

/**
 * Decide whether this module is the process entrypoint (i.e. it was run
 * directly, not merely imported by another package).
 *
 * Importing `@stream-screen/ai` must NEVER start the MCP/REST server as a side
 * effect — doing so would take over stdio. We therefore require an exact match
 * between the resolved CLI entry (`process.argv[1]`, normalized to a file URL)
 * and this module's own URL. No `endsWith('index.js')` heuristic: an importing
 * app's entrypoint is very commonly named `index.js`, which would spuriously
 * start the server.
 *
 * SYMLINK CAVEAT (P2): npm installs the `streamscreen-ai` `.bin` entry as a
 * SYMLINK to `dist/index.js` on Unix. Executing the symlinked shebang leaves
 * `process.argv[1]` as the symlink path, while `import.meta.url` resolves to the
 * real `dist/index.js`. A naive URL comparison then returns false and the
 * installed CLI exits without starting the server. We therefore resolve the
 * realpath of both the entry and the module file before comparing. If realpath
 * throws (e.g. the path no longer exists), we fall back to the plain file-URL
 * comparison so behaviour never regresses below the previous exact match.
 *
 * @param entry      The CLI entrypoint path (typically `process.argv[1]`).
 * @param moduleUrl  This module's URL (typically `import.meta.url`).
 * @param realpath   Injectable realpath resolver (defaults to `realpathSync`),
 *                   for testability.
 */
export function isDirectRun(
  entry: string | undefined,
  moduleUrl: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!entry) return false;

  const entryUrl = pathToFileURL(entry).href;
  if (entryUrl === moduleUrl) return true;

  // Resolve symlinks on both sides so a symlinked `.bin` entry that points at
  // the real module file is recognised as a direct run.
  try {
    const realEntry = realpath(entry);
    const realModule = realpath(fileURLToPath(moduleUrl));
    return pathToFileURL(realEntry).href === pathToFileURL(realModule).href;
  } catch {
    // realpath failed (missing path, permissions, etc.) — fall back to the
    // exact URL comparison already computed above (which was not a match).
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[streamscreen-ai] fatal:', err);
    process.exit(1);
  });
}
