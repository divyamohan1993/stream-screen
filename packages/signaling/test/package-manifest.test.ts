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
