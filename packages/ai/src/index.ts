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
 *
 * Always free, no time limits, no bitrate caps.
 */

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
    console.error(`[streamscreen-ai] REST API listening on http://0.0.0.0:${port}`);
  } else {
    await startMcpServer();
    // MCP uses stdout for protocol traffic; log to stderr only.
    // eslint-disable-next-line no-console
    console.error('[streamscreen-ai] MCP server ready on stdio');
  }
}

// Run only when invoked directly (not when imported).
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${entry}`).href || entry.endsWith('index.js');
})();

if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[streamscreen-ai] fatal:', err);
    process.exit(1);
  });
}
