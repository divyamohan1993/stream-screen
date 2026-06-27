import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for packaging: src/server.ts imports a RUNTIME value
 * (`isSignalMessage`) from @stream-screen/core. If core were only a devDependency,
 * `node dist/index.js` would fail module resolution when the streamscreen-signaling
 * bin is installed/run outside the monorepo (dev deps are not installed there).
 * So @stream-screen/core MUST be a runtime `dependency`, not (only) a devDependency.
 */
describe('signaling package.json runtime deps', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bin?: Record<string, string>;
  };

  it('declares @stream-screen/core under dependencies', () => {
    expect(pkg.dependencies?.['@stream-screen/core']).toBeDefined();
  });

  it('does not list @stream-screen/core only under devDependencies', () => {
    const inDev = pkg.devDependencies?.['@stream-screen/core'] !== undefined;
    const inRuntime = pkg.dependencies?.['@stream-screen/core'] !== undefined;
    expect(inRuntime).toBe(true);
    // It is fine to be absent from devDependencies, but it must never be
    // present in devDependencies without also being a runtime dependency.
    if (inDev) {
      expect(inRuntime).toBe(true);
    }
  });
});

/**
 * Regression guard for the executable bin: package.json exposes dist/index.js as
 * the `streamscreen-signaling` command. On Unix the OS execs that file via its
 * shebang, so dist/index.js MUST begin with `#!/usr/bin/env node` or running the
 * installed bin fails ("cannot execute binary file" / syntax error). TypeScript
 * preserves a first-line shebang in src/index.ts into the emitted dist file, so
 * we assert the source first line is exactly the shebang AND the bin mapping
 * points at dist/index.js. If a built dist/index.js exists, we also assert it
 * starts with the shebang.
 */
describe('signaling executable bin shebang', () => {
  const SHEBANG = '#!/usr/bin/env node';
  const srcPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const distPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: Record<string, string> };

  it('starts src/index.ts with the node shebang on the very first line', () => {
    const firstLine = readFileSync(srcPath, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe(SHEBANG);
  });

  it('maps the streamscreen-signaling bin to dist/index.js', () => {
    expect(pkg.bin?.['streamscreen-signaling']).toBe('dist/index.js');
  });

  it('emits the shebang as the first line of the built dist/index.js (when built)', () => {
    let built: string;
    try {
      built = readFileSync(distPath, 'utf8');
    } catch {
      // Not built in this run; the source + bin assertions above are the
      // deterministic guard. Skip the built-artifact check.
      return;
    }
    expect(built.split('\n', 1)[0]).toBe(SHEBANG);
  });
});
