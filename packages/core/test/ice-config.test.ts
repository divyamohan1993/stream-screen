import { describe, it, expect } from 'vitest';
import { parseIceServers, serializeIceServers } from '../src/ice-config.js';

describe('parseIceServers — JSON form', () => {
  it('parses a JSON array string of RTCIceServer objects', () => {
    const json = JSON.stringify([
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ]);
    expect(parseIceServers(json)).toEqual([
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ]);
  });

  it('accepts an already-parsed array (not a string)', () => {
    expect(
      parseIceServers([{ urls: 'stun:stun.example.com:3478' }]),
    ).toEqual([{ urls: 'stun:stun.example.com:3478' }]);
  });

  it('coerces a multi-url entry (string[] urls)', () => {
    expect(
      parseIceServers([
        { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' },
      ]),
    ).toEqual([
      { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' },
    ]);
  });

  it('drops JSON entries with no valid url and unknown schemes', () => {
    expect(
      parseIceServers([
        { urls: 'http:not-ice.example.com' },
        { username: 'u', credential: 'p' },
        { urls: 'stun:ok.example.com:3478' },
        'garbage',
        42,
        null,
      ] as unknown[]),
    ).toEqual([{ urls: 'stun:ok.example.com:3478' }]);
  });

  it('does not carry empty username/credential through', () => {
    expect(
      parseIceServers([{ urls: 'turn:t.example.com:3478', username: '', credential: '' }]),
    ).toEqual([{ urls: 'turn:t.example.com:3478' }]);
  });
});

describe('parseIceServers — compact form', () => {
  it('parses a bare stun url', () => {
    expect(parseIceServers('stun:stun.example.com:3478')).toEqual([
      { urls: 'stun:stun.example.com:3478' },
    ]);
  });

  it('parses turn with inline user:pass creds', () => {
    expect(parseIceServers('turn:user:pass@turn.example.com:3478')).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
    ]);
  });

  it('parses turns (TLS) with inline creds', () => {
    expect(parseIceServers('turns:user:pass@turn.example.com:5349')).toEqual([
      { urls: 'turns:turn.example.com:5349', username: 'user', credential: 'pass' },
    ]);
  });

  it('parses a mixed comma-separated list', () => {
    expect(
      parseIceServers(
        'stun:stun.example.com:3478, turn:user:pass@turn.example.com:3478, turns:user:pass@turn.example.com:5349',
      ),
    ).toEqual([
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
      { urls: 'turns:turn.example.com:5349', username: 'user', credential: 'pass' },
    ]);
  });

  it('tolerates whitespace-only separators and extra spaces', () => {
    expect(parseIceServers('  stun:a.example.com:3478   turn:u:p@b.example.com:3478  ')).toEqual([
      { urls: 'stun:a.example.com:3478' },
      { urls: 'turn:b.example.com:3478', username: 'u', credential: 'p' },
    ]);
  });

  it('parses turn with username only (no password)', () => {
    expect(parseIceServers('turn:user@turn.example.com:3478')).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'user' },
    ]);
  });

  it('uses the last @ to separate creds from the authority', () => {
    expect(parseIceServers('turn:user:pa@ss@turn.example.com:3478')).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pa@ss' },
    ]);
  });

  it('lowercases the scheme', () => {
    expect(parseIceServers('STUN:stun.example.com:3478')).toEqual([
      { urls: 'stun:stun.example.com:3478' },
    ]);
  });
});

describe('parseIceServers — blanks and garbage', () => {
  it('returns [] for empty / whitespace / null / undefined', () => {
    expect(parseIceServers('')).toEqual([]);
    expect(parseIceServers('   ')).toEqual([]);
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers(undefined)).toEqual([]);
  });

  it('returns [] for non-string / non-array primitives', () => {
    expect(parseIceServers(42 as unknown)).toEqual([]);
    expect(parseIceServers(true as unknown)).toEqual([]);
    expect(parseIceServers({ urls: 'stun:x.example.com' } as unknown)).toEqual([]);
  });

  it('returns [] for invalid JSON array text and never throws', () => {
    expect(parseIceServers('[not valid json')).toEqual([]);
    expect(parseIceServers('[}')).toEqual([]);
  });

  it('drops unknown-scheme and malformed compact tokens, keeps valid ones', () => {
    expect(
      parseIceServers('http://x.example.com, ftp:y, ,, stun:good.example.com:3478, :::, turn:'),
    ).toEqual([{ urls: 'stun:good.example.com:3478' }]);
  });

  it('never throws on arbitrary user input', () => {
    const inputs: unknown[] = ['@@@', 'turn:', ':pass@host', '{}', '[1,2,3]', Symbol('x') as unknown];
    for (const i of inputs) {
      expect(() => parseIceServers(i)).not.toThrow();
    }
  });
});

describe('serializeIceServers / round-trip', () => {
  it('serializes stun and turn (with creds) back to compact form', () => {
    const servers: RTCIceServer[] = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
    ];
    expect(serializeIceServers(servers)).toBe(
      'stun:stun.example.com:3478, turn:user:pass@turn.example.com:3478',
    );
  });

  it('round-trips compact -> parse -> serialize -> parse', () => {
    const compact =
      'stun:stun.example.com:3478, turn:user:pass@turn.example.com:3478, turns:user:pass@turn.example.com:5349';
    const parsed = parseIceServers(compact);
    const reparsed = parseIceServers(serializeIceServers(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it('expands multi-url entries into one token each on serialize', () => {
    const servers: RTCIceServer[] = [
      { urls: ['turn:t.example.com:3478', 'turns:t.example.com:5349'], username: 'u', credential: 'p' },
    ];
    expect(serializeIceServers(servers)).toBe(
      'turn:u:p@t.example.com:3478, turns:u:p@t.example.com:5349',
    );
  });
});
