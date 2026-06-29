/**
 * copy-assets — copy the host renderer's static assets into dist/renderer/.
 *
 * `tsc` only emits the compiled JS (dist/renderer/renderer.js); it never copies
 * the HTML/CSS the control window loads via
 * `loadFile(join(__dirname,'renderer','index.html'))`. Without this step the
 * packaged app (electron-builder ships only `dist/**`) opens a BLANK window.
 *
 * This runs AFTER tsc in the `build` script. It uses only `node:fs` / `node:path`
 * so there is no extra dependency and it works on every platform / in CI.
 *
 * It copies src/renderer/index.html plus any sibling static assets (.css, images)
 * referenced from the renderer, preserving the dist/renderer/ layout the main
 * process resolves at runtime.
 */
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const srcRenderer = join(pkgRoot, 'src', 'renderer');
const dstRenderer = join(pkgRoot, 'dist', 'renderer');

/** Static asset extensions to ship alongside the compiled renderer JS. */
const STATIC_EXT = new Set(['.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp']);

mkdirSync(dstRenderer, { recursive: true });

let copied = 0;
for (const entry of readdirSync(srcRenderer, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!STATIC_EXT.has(extname(entry.name).toLowerCase())) continue;
  copyFileSync(join(srcRenderer, entry.name), join(dstRenderer, entry.name));
  copied += 1;
}

console.log(`copy-assets: copied ${copied} renderer asset(s) into dist/renderer/`);
