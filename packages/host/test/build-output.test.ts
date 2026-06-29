/**
 * Regression test for the broken build-output layout (CODEX P1, Findings 1 & 2).
 *
 * Finding 1: tsconfig used rootDir '.' + include 'src', so `tsc` emitted the
 * main process to dist/src/main.js, but package.json "main" pointed at
 * dist/main.js — `electron .` and packaged builds failed to find the entrypoint.
 * The fix sets rootDir 'src' / outDir 'dist' so it emits dist/main.js, and
 * "main" must agree with the path tsc actually produces for src/main.ts.
 *
 * Finding 2: the build only ran `tsc` and never copied src/renderer/index.html
 * into dist/renderer/, so the packaged control window (electron-builder ships
 * only dist/**) was BLANK. The fix adds scripts/copy-assets.mjs and chains it
 * after tsc in the build script.
 *
 * Finding 3 (NEW): copying assets is not enough — `tsc` still shipped RAW module
 * JS. dist/renderer/renderer.js (loaded as a `<script type=module>` over file://
 * with nodeIntegration:false) transitively imported the BARE specifier
 * '@stream-screen/core' (via ../host-session.js), which a browser cannot resolve
 * from file://; and dist/preload.js started with ESM `import` while the window
 * uses sandbox:true, where the preload must be CommonJS. Either way the packaged
 * control window could not start the session. The fix BUNDLES both with esbuild:
 * the renderer to a browser ES module with every dep INLINED (no bare
 * '@stream-screen/...' specifier survives), and the preload to a sandbox-safe
 * CJS module with only 'electron' external.
 *
 * These assertions are derived purely from tsconfig + package.json (no Electron),
 * plus an end-to-end check that `npm run build` materializes dist/main.js,
 * dist/renderer/index.html, a CJS preload, and a fully-inlined renderer. They
 * fail before the fix and pass after.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

/**
 * Compute where tsc emits src/main.ts given rootDir/outDir, exactly as the
 * compiler maps input paths: strip rootDir, re-root under outDir, swap .ts→.js.
 */
function emittedMainPath(rootDir: string, outDir: string): string {
  const srcEntry = 'src/main.ts';
  const rel = relative(rootDir, srcEntry); // 'main.ts' when rootDir === 'src'
  return join(outDir, rel).replace(/\.ts$/, '.js').split('\\').join('/');
}

describe('host build output consistency (P1 regression)', () => {
  const tsconfig = readJson(join(pkgRoot, 'tsconfig.json'));
  const pkg = readJson(join(pkgRoot, 'package.json'));
  const co = (tsconfig.compilerOptions ?? {}) as Record<string, string>;

  it('emits the main process to the path package.json "main" expects', () => {
    const rootDir = co.rootDir;
    const outDir = co.outDir;
    expect(rootDir, 'tsconfig.compilerOptions.rootDir must be set').toBeTruthy();
    expect(outDir, 'tsconfig.compilerOptions.outDir must be set').toBeTruthy();

    const emitted = emittedMainPath(rootDir, outDir);
    // The crux of Finding 1: these MUST agree, else `electron .` can't boot.
    expect(pkg.main).toBe(emitted);
    // Specifically the flat layout (not the broken dist/src/main.js).
    expect(pkg.main).toBe('dist/main.js');
  });

  it('chains a renderer-asset copy step after tsc in the build script', () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.build).toContain('tsc');
    expect(scripts.build).toContain('copy-assets.mjs');
  });

  it('bundles the renderer + preload after tsc (Finding 3)', () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.build).toContain('bundle.mjs');
    // esbuild is the bundler and must be declared so CI installs it.
    const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
    expect(dev.esbuild, 'esbuild must be a devDependency').toBeTruthy();
  });

  it('ships a bundle script that produces a CJS preload and a browser renderer', () => {
    const scriptPath = join(pkgRoot, 'scripts', 'bundle.mjs');
    expect(existsSync(scriptPath)).toBe(true);
    const src = readFileSync(scriptPath, 'utf8');
    expect(src).toContain('esbuild');
    // Preload is CJS with only electron external; renderer is a browser bundle.
    expect(src).toContain("format: 'cjs'");
    expect(src).toContain("external: ['electron']");
    expect(src).toContain("platform: 'browser'");
  });

  it('ships a copy-assets script that targets the renderer index.html', () => {
    const scriptPath = join(pkgRoot, 'scripts', 'copy-assets.mjs');
    expect(existsSync(scriptPath)).toBe(true);
    const src = readFileSync(scriptPath, 'utf8');
    // It copies into dist/renderer and handles .html (the index.html the main
    // process loads via loadFile(join(__dirname,'renderer','index.html'))).
    expect(src).toContain('renderer');
    expect(src).toContain('.html');
  });

  it('produces dist/main.js AND dist/renderer/index.html after a real build', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: pkgRoot,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    });
    expect(existsSync(join(pkgRoot, 'dist', 'main.js'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'dist', 'renderer', 'index.html'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'dist', 'preload.js'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'dist', 'renderer', 'renderer.js'))).toBe(true);
  }, 120_000);

  it('produces a bundled renderer with NO unresolved bare workspace import', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: pkgRoot,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    });
    const rendererPath = join(pkgRoot, 'dist', 'renderer', 'renderer.js');
    expect(existsSync(rendererPath)).toBe(true);
    const renderer = readFileSync(rendererPath, 'utf8');
    // The crux of Finding 3: a browser file:// loader cannot resolve bare
    // specifiers. After bundling, NONE of the workspace deps remain bare —
    // they are inlined into the bundle.
    expect(renderer).not.toMatch(/from\s+["']@stream-screen\//);
    expect(renderer).not.toMatch(/require\(\s*["']@stream-screen\//);
    // Relative imports of sibling tsc output must also be gone (inlined), since
    // ../host-session.js is what dragged in the bare core import.
    expect(renderer).not.toMatch(/from\s+["']\.\.\/host-session/);
  }, 120_000);

  it('produces a bundled main process with NO unresolved workspace import', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: pkgRoot,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    });
    const mainPath = join(pkgRoot, 'dist', 'main.js');
    expect(existsSync(mainPath)).toBe(true);
    const main = readFileSync(mainPath, 'utf8');
    expect(main).not.toMatch(/from\s+["']@stream-screen\//);
    expect(main).not.toMatch(/require\(\s*["']@stream-screen\//);
    expect(main).toMatch(/from\s+["']electron["']/);
  }, 120_000);

  it('produces a sandbox-safe CJS preload with deps inlined (only electron external)', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: pkgRoot,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    });
    const preloadPath = join(pkgRoot, 'dist', 'preload.js');
    expect(existsSync(preloadPath)).toBe(true);
    const preload = readFileSync(preloadPath, 'utf8');
    // CJS, not ESM: a sandboxed preload cannot start with bare `import` and must
    // be loadable as CommonJS (uses module.exports / require).
    expect(preload).not.toMatch(/^\s*import\s/m);
    expect(preload).toMatch(/module\.exports|exports\./);
    // Only 'electron' may stay external (sandboxed preloads may require it);
    // workspace deps must be inlined, never required bare.
    expect(preload).not.toMatch(/require\(\s*["']@stream-screen\//);
    expect(preload).toMatch(/require\(\s*["']electron["']\s*\)/);
  }, 120_000);
});
