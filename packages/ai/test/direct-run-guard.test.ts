/**
 * Regression test for the "is this module the process entrypoint?" guard.
 *
 * BUG (P2): the old guard returned true whenever `process.argv[1]` ended with
 * `index.js`. Because an importing application's entrypoint is very commonly
 * named `index.js`, merely importing `@stream-screen/ai` would start the
 * MCP/REST server as a side effect and take over stdio.
 *
 * The fix: only run the server when the resolved CLI entry (as a file URL)
 * exactly equals this module's URL.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isDirectRun } from '../src/index.js';

describe('isDirectRun', () => {
  const moduleUrl = 'file:///app/node_modules/@stream-screen/ai/dist/index.js';

  it('is TRUE when argv[1] resolves to this module URL', () => {
    const entry = fileURLToPath(moduleUrl);
    expect(isDirectRun(entry, moduleUrl)).toBe(true);
  });

  it('is FALSE when an importing app entrypoint is named index.js elsewhere', () => {
    // The exact filename that used to trip the broken `endsWith('index.js')`
    // heuristic, but in a different directory (the consuming app).
    const entry = '/app/index.js';
    expect(pathToFileURL(entry).href).not.toBe(moduleUrl);
    expect(isDirectRun(entry, moduleUrl)).toBe(false);
  });

  it('is FALSE for any other importer entrypoint', () => {
    expect(isDirectRun('/some/other/app/main.js', moduleUrl)).toBe(false);
  });

  it('is FALSE when there is no argv[1]', () => {
    expect(isDirectRun(undefined, moduleUrl)).toBe(false);
  });

  it('normalizes argv[1] paths to a file URL before comparing', () => {
    // A plain filesystem path (not a URL) for the real module must still match.
    const entry = fileURLToPath(moduleUrl);
    expect(entry.startsWith('file://')).toBe(false);
    expect(isDirectRun(entry, moduleUrl)).toBe(true);
  });
});
