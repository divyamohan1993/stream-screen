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
 * These assertions are derived purely from tsconfig + package.json (no Electron),
 * plus an end-to-end check that `npm run build` materializes both dist/main.js
 * and dist/renderer/index.html. They fail before the fix and pass after.
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
});
