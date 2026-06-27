/**
 * Bundle @stream-screen/core into a single browser-loadable ESM file that the
 * Playwright fixture pages import directly.
 *
 * We bundle the package's TypeScript source (not its dist) so the e2e suite
 * never depends on a separate build step having run first, and we target the
 * browser. The `ws` import inside the signaling client is only reached in node;
 * in the browser the global `WebSocket` is used, so we stub `ws` to keep the
 * bundle self-contained and free of node built-ins.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const coreEntry = resolve(here, '../../packages/core/src/index.ts');
const outFile = resolve(here, '../fixtures/core.bundle.js');

mkdirSync(dirname(outFile), { recursive: true });

/**
 * Stub the optional node-only `ws` dependency. The browser bundle never reaches
 * the dynamic `import('ws')` branch (global WebSocket exists), but esbuild still
 * tries to resolve it; this plugin satisfies the resolver with a harmless shim.
 */
const stubWs = {
  name: 'stub-ws',
  setup(b) {
    b.onResolve({ filter: /^ws$/ }, () => ({ path: 'ws', namespace: 'stub-ws' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-ws' }, () => ({
      contents:
        'export const WebSocket = globalThis.WebSocket; export default globalThis.WebSocket;',
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [coreEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: outFile,
  sourcemap: false,
  plugins: [stubWs],
  logLevel: 'info',
});

// Emit a sibling .d.ts so specs that `import('./core.bundle.js')` inside
// page.evaluate type-check (the import runs in the browser, but tsc still
// resolves the specifier against the node-side declaration). One next to the
// bundle and one next to the specs, since each uses its own relative path.
const dts = `export * from '@stream-screen/core';\n`;
writeFileSync(resolve(here, '../fixtures/core.bundle.d.ts'), dts);
writeFileSync(resolve(here, '../tests/core.bundle.d.ts'), dts);

console.log(`[e2e] bundled core -> ${outFile}`);
