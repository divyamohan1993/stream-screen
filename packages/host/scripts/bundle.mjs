/**
 * bundle — produce browser/sandbox-safe outputs for the host renderer & preload.
 *
 * `tsc` alone emits raw module JS that the packaged control window cannot run:
 *
 *   - dist/renderer/renderer.js is loaded as a `<script type=module>` over
 *     file:// with nodeIntegration:false. Its (transitive) imports include bare
 *     specifiers like '@stream-screen/core' (via ../host-session.js) which a
 *     browser cannot resolve from file://. Result: the renderer never loads and
 *     the session never starts.
 *   - dist/preload.js starts with ESM `import` statements, but the window uses
 *     sandbox:true, where the preload runs in a restricted CommonJS context. A
 *     bare ESM preload throws on load, so the contextBridge API is never exposed.
 *
 * This step BUNDLES both with esbuild so all workspace/3rd-party deps are inlined:
 *
 *   renderer.ts -> dist/renderer/renderer.js   (format esm, platform browser,
 *                  bundle:true → @stream-screen/core + host-session inlined,
 *                  NO bare '@stream-screen/...' import remains; <script type=module> safe)
 *   preload.ts  -> dist/preload.js             (format cjs, platform node,
 *                  bundle:true with ONLY 'electron' external — sandboxed preloads
 *                  may `require('electron')` but nothing else; CJS-compatible)
 *
 * The main process (dist/main.js) stays plain `tsc` output (it runs in Node in
 * the Electron main process and may keep bare imports / ESM).
 *
 * Runs AFTER tsc in the `build` script. Depends only on esbuild (a devDep) and
 * node builtins, so it works on every platform and in CI.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const src = join(pkgRoot, 'src');
const dist = join(pkgRoot, 'dist');

// Bundle the main process so @stream-screen/core is build-time-only. Keep the
// Electron runtime and optional native input module external; Electron provides
// the former, while the latter may be absent and is handled gracefully.
await build({
  entryPoints: [join(src, 'main.ts')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  external: ['electron', '@nut-tree-fork/nut-js'],
  logLevel: 'info',
});

// Bundle the renderer: a browser ES module with every dependency inlined so no
// bare specifier survives for the file:// loader to choke on.
await build({
  entryPoints: [join(src, 'renderer', 'renderer.ts')],
  outfile: join(dist, 'renderer', 'renderer.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'info',
  // No externals: '@stream-screen/core', host-session, capture, etc. are INLINED.
});

// Bundle the preload as a sandbox-safe CommonJS module. Only 'electron' stays
// external (a sandboxed preload is allowed to require('electron')); everything
// else — including any workspace code — is inlined.
await build({
  entryPoints: [join(src, 'preload.ts')],
  outfile: join(dist, 'preload.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'info',
});

console.log('bundle: wrote dist/main.js (esm), dist/renderer/renderer.js (esm), and dist/preload.js (cjs)');
