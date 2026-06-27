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
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * Regression for the symlinked `.bin` entrypoint (P2). npm installs the
 * `streamscreen-ai` bin as a symlink to `dist/index.js`. When the symlinked
 * shebang is executed, `process.argv[1]` is the symlink path while
 * `import.meta.url` is the real `dist/index.js`. The guard must resolve
 * realpaths before comparing so the installed CLI actually starts the server.
 */
describe('isDirectRun — symlinked bin entry', () => {
  // Map a path string to the realpath it should resolve to. Anything not in the
  // map is treated as a real file that resolves to itself.
  const linkTarget = '/app/node_modules/@stream-screen/ai/dist/index.js';
  const binSymlink = '/app/node_modules/.bin/streamscreen-ai';
  const moduleUrl = pathToFileURL(linkTarget).href;

  const fakeRealpath =
    (links: Record<string, string>) =>
    (p: string): string =>
      links[p] ?? p;

  it('is TRUE when argv[1] is a symlink whose realpath === the module file', () => {
    const realpath = fakeRealpath({ [binSymlink]: linkTarget });
    // Without realpath resolution the plain URLs differ...
    expect(pathToFileURL(binSymlink).href).not.toBe(moduleUrl);
    // ...but resolving the symlink makes them match.
    expect(isDirectRun(binSymlink, moduleUrl, realpath)).toBe(true);
  });

  it('is FALSE for a different entrypoint that is also named index.js', () => {
    const otherIndex = '/app/index.js';
    const realpath = fakeRealpath({});
    expect(isDirectRun(otherIndex, moduleUrl, realpath)).toBe(false);
  });

  it('is FALSE for an unrelated symlink that resolves elsewhere', () => {
    const realpath = fakeRealpath({ [binSymlink]: '/app/some/other/main.js' });
    expect(isDirectRun(binSymlink, moduleUrl, realpath)).toBe(false);
  });

  it('falls back to the URL comparison when realpath throws', () => {
    const throwing = (): never => {
      throw new Error('ENOENT');
    };
    // Exact URL match still succeeds without ever needing realpath.
    const entry = fileURLToPath(moduleUrl);
    expect(isDirectRun(entry, moduleUrl, throwing)).toBe(true);
    // A symlink path that would only match via realpath now returns false
    // because realpath throws and we fall back to the (non-matching) URL check.
    expect(isDirectRun(binSymlink, moduleUrl, throwing)).toBe(false);
  });
});

/**
 * End-to-end variant using a real temp symlink on disk (no injection), to prove
 * the default `realpathSync` resolver behaves as expected.
 */
describe('isDirectRun — real on-disk symlink', () => {
  let dir: string;
  let realModule: string;
  let symlink: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-ai-directrun-'));
    realModule = join(dir, 'index.js');
    writeFileSync(realModule, '// fake module\n');
    symlink = join(dir, 'streamscreen-ai');
    symlinkSync(realModule, symlink);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is TRUE when argv[1] is a real symlink to the module file', () => {
    const moduleUrl = pathToFileURL(realModule).href;
    expect(pathToFileURL(symlink).href).not.toBe(moduleUrl);
    expect(isDirectRun(symlink, moduleUrl)).toBe(true);
  });

  it('is FALSE for a real sibling file that is not the module', () => {
    const other = join(dir, 'other.js');
    writeFileSync(other, '// other\n');
    const moduleUrl = pathToFileURL(realModule).href;
    expect(isDirectRun(other, moduleUrl)).toBe(false);
  });
});
