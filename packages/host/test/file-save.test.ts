/**
 * Unit tests for the pure file-save path logic (sanitization + collision-safe
 * naming). The filesystem `exists` predicate is injected so these run anywhere.
 */

import { describe, expect, it } from 'vitest';
import { resolveDownloadPath, sanitizeFileName } from '../src/file-save.js';

describe('sanitizeFileName', () => {
  it('keeps a normal name untouched', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
  });

  it('strips directory components (POSIX and Windows)', () => {
    expect(sanitizeFileName('/etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('../../secret.txt')).toBe('secret.txt');
  });

  it('removes illegal characters', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe('abcdefgh.txt');
  });

  it('falls back when the name sanitizes to nothing', () => {
    expect(sanitizeFileName('..')).toBe('streamscreen-download');
    expect(sanitizeFileName('...')).toBe('streamscreen-download');
    expect(sanitizeFileName('   ')).toBe('streamscreen-download');
    expect(sanitizeFileName('', 'fallbk')).toBe('fallbk');
  });
});

describe('resolveDownloadPath', () => {
  it('returns the plain path when nothing collides', () => {
    expect(resolveDownloadPath('/dl', 'a.txt', () => false)).toBe('/dl/a.txt');
  });

  it('inserts a numeric suffix before the extension on collision', () => {
    const taken = new Set(['/dl/a.txt', '/dl/a (1).txt']);
    expect(resolveDownloadPath('/dl', 'a.txt', (p) => taken.has(p))).toBe('/dl/a (2).txt');
  });

  it('handles names without an extension', () => {
    const taken = new Set(['/dl/README']);
    expect(resolveDownloadPath('/dl', 'README', (p) => taken.has(p))).toBe('/dl/README (1)');
  });

  it('sanitizes the name before resolving', () => {
    expect(resolveDownloadPath('/dl', '../../x.bin', () => false)).toBe('/dl/x.bin');
  });
});
