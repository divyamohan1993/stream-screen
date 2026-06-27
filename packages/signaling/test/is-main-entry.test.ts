import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainEntry } from '../src/index.js';

/**
 * Regression for index.ts:206 — the .bin entry is a SYMLINK to dist/index.js on
 * Unix, so process.argv[1] (the symlink) differed from import.meta.url (the
 * resolved target) and the bin exited without starting the server.
 */
describe('isMainEntry — resolves symlinked bin entrypoints before comparing', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'streamscreen-signaling-'));
    tmpDirs.push(d);
    return d;
  }

  it('returns TRUE when argv[1] is a SYMLINK whose realpath is the module file (server would start)', () => {
    const dir = makeTmpDir();
    const target = join(dir, 'index.js');
    const link = join(dir, 'streamscreen-signaling');
    writeFileSync(target, '// fake dist/index.js\n');
    symlinkSync(target, link);

    // moduleUrl is the resolved target; argv[1] is the symlink path.
    const moduleUrl = pathToFileURL(target).href;
    expect(isMainEntry(moduleUrl, link)).toBe(true);
  });

  it('returns TRUE for a direct (non-symlink) launch of the module file', () => {
    const dir = makeTmpDir();
    const target = join(dir, 'index.js');
    writeFileSync(target, '// fake dist/index.js\n');
    const moduleUrl = pathToFileURL(target).href;
    expect(isMainEntry(moduleUrl, target)).toBe(true);
  });

  it('returns FALSE for an unrelated entry (module was merely imported)', () => {
    const dir = makeTmpDir();
    const me = join(dir, 'index.js');
    const other = join(dir, 'some-other-cli.js');
    writeFileSync(me, '// me\n');
    writeFileSync(other, '// other\n');
    const moduleUrl = pathToFileURL(me).href;
    expect(isMainEntry(moduleUrl, other)).toBe(false);
  });

  it('returns FALSE when argv[1] is undefined', () => {
    expect(isMainEntry('file:///anything/index.js', undefined)).toBe(false);
  });

  it('falls back to the direct URL comparison when realpath THROWS (e.g. missing file)', () => {
    const moduleUrl = 'file:///opt/app/dist/index.js';
    const throwingRealpath = (): string => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    // argv[1] equals the module path -> direct match must still return true.
    expect(isMainEntry(moduleUrl, '/opt/app/dist/index.js', throwingRealpath)).toBe(true);
    // And an unrelated path still returns false via the fallback.
    expect(isMainEntry(moduleUrl, '/opt/app/dist/other.js', throwingRealpath)).toBe(false);
  });

  it('returns TRUE via an INJECTED realpath that resolves a symlink to the module file', () => {
    const moduleUrl = 'file:///opt/app/dist/index.js';
    const fakeRealpath = (p: string): string =>
      p === '/usr/local/bin/streamscreen-signaling' ? '/opt/app/dist/index.js' : p;
    expect(isMainEntry(moduleUrl, '/usr/local/bin/streamscreen-signaling', fakeRealpath)).toBe(
      true,
    );
  });
});
