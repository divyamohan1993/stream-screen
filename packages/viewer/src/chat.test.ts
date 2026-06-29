import { describe, it, expect } from 'vitest';
import { sanitizeChat, isSendableChat, MAX_CHAT_LENGTH } from './chat.js';

describe('sanitizeChat', () => {
  it('escapes HTML-significant characters so markup cannot be injected', () => {
    const out = sanitizeChat('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&gt;');
  });

  it('escapes ampersands, quotes, and apostrophes', () => {
    expect(sanitizeChat('a & b')).toBe('a &amp; b');
    expect(sanitizeChat('say "hi"')).toBe('say &quot;hi&quot;');
    expect(sanitizeChat("it's")).toBe('it&#39;s');
  });

  it('strips control characters but keeps tab/newline/CR', () => {
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const DEL = String.fromCharCode(127);
    const out = sanitizeChat(`a${NUL}b${BEL}c\td\ne${DEL}`);
    // Control chars removed; printable + tab/newline preserved.
    expect(out).toBe('abc\td\ne');
    expect(out).not.toContain(NUL);
    expect(out).not.toContain(BEL);
    expect(out).not.toContain(DEL);
    expect(out).toContain('\t');
    expect(out).toContain('\n');
  });

  it('trims and bounds length', () => {
    expect(sanitizeChat('   hi   ')).toBe('hi');
    const long = 'x'.repeat(MAX_CHAT_LENGTH + 500);
    expect(sanitizeChat(long).length).toBe(MAX_CHAT_LENGTH);
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeChat(null)).toBe('');
    expect(sanitizeChat(undefined)).toBe('');
    expect(sanitizeChat(42)).toBe('');
    expect(sanitizeChat({})).toBe('');
  });
});

describe('isSendableChat', () => {
  it('is false for blank/whitespace/control-only input', () => {
    expect(isSendableChat('')).toBe(false);
    expect(isSendableChat('   ')).toBe(false);
    expect(isSendableChat(String.fromCharCode(0, 7))).toBe(false);
  });
  it('is true for real content', () => {
    expect(isSendableChat('hello')).toBe(true);
  });
});
