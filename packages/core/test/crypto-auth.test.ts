import { describe, it, expect } from 'vitest';
import {
  AUTH_DOMAIN,
  DEFAULT_PBKDF2_ITERATIONS,
  randomBytes,
  deriveKey,
  computeProof,
  constantTimeEqual,
  validatePin,
  makeVerifier,
  serializeVerifier,
  parseVerifier,
  verifyProofAgainst,
  toBase64,
  fromBase64,
  type ProofParts,
} from '../src/crypto-auth.js';
import { Peer } from '../src/peer.js';

// Use a reduced iteration count for the determinism/proof tests so the suite
// stays fast; the policy default is exercised separately and cheaply.
const ITERS = 1000;

function parts(over: Partial<ProofParts> = {}): ProofParts {
  return {
    domain: AUTH_DOMAIN,
    nonceH: new Uint8Array([1, 2, 3, 4]),
    nonceV: new Uint8Array([5, 6, 7, 8]),
    channelBinding: 'aa|bb',
    ...over,
  };
}

describe('randomBytes', () => {
  it('returns the requested length and is not all-zero', () => {
    const a = randomBytes(32);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(a.some((b) => b !== 0)).toBe(true);
  });

  it('produces distinct values across calls', () => {
    expect(toBase64(randomBytes(16))).not.toBe(toBase64(randomBytes(16)));
  });
});

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32, 100]) {
      const src = randomBytes(n);
      expect([...fromBase64(toBase64(src))]).toEqual([...src]);
    }
  });
});

describe('deriveKey (PBKDF2-HMAC-SHA256)', () => {
  it('is deterministic for the same pin+salt+iterations', async () => {
    const salt = new Uint8Array(16).fill(7);
    const k1 = await deriveKey('hunter2x', salt, ITERS);
    const k2 = await deriveKey('hunter2x', salt, ITERS);
    expect(k1.length).toBe(32);
    expect([...k1]).toEqual([...k2]);
  });

  it('differs for a different salt', async () => {
    const k1 = await deriveKey('hunter2x', new Uint8Array(16).fill(1), ITERS);
    const k2 = await deriveKey('hunter2x', new Uint8Array(16).fill(2), ITERS);
    expect([...k1]).not.toEqual([...k2]);
  });

  it('differs for a different pin', async () => {
    const salt = new Uint8Array(16).fill(9);
    const k1 = await deriveKey('hunter2x', salt, ITERS);
    const k2 = await deriveKey('hunter2y', salt, ITERS);
    expect([...k1]).not.toEqual([...k2]);
  });

  it('matches a known PBKDF2-HMAC-SHA256 test vector', async () => {
    // RFC-style independent vector: pin 'password', salt 'salt', 1 iteration.
    const k = await deriveKey('password', new TextEncoder().encode('salt'), 1);
    // First 32 bytes of PBKDF2-HMAC-SHA256('password','salt',1).
    expect(toBase64(k)).toBe('Eg+2z/z4syxD5yJSVsT4N6hlSMkszDVICAWYfLcL4Xs=');
  });
});

describe('computeProof', () => {
  it('matches for identical key + parts', async () => {
    const key = await deriveKey('secret9', new Uint8Array(16).fill(3), ITERS);
    const p1 = await computeProof(key, parts());
    const p2 = await computeProof(key, parts());
    expect(p1.length).toBe(32);
    expect(constantTimeEqual(p1, p2)).toBe(true);
  });

  it('differs when the pin (key) differs', async () => {
    const salt = new Uint8Array(16).fill(4);
    const kRight = await deriveKey('rightpin', salt, ITERS);
    const kWrong = await deriveKey('wrongpin', salt, ITERS);
    const p1 = await computeProof(kRight, parts());
    const p2 = await computeProof(kWrong, parts());
    expect(constantTimeEqual(p1, p2)).toBe(false);
  });

  it('differs when the channel binding changes (MITM defense)', async () => {
    const key = await deriveKey('secret9', new Uint8Array(16).fill(3), ITERS);
    const p1 = await computeProof(key, parts({ channelBinding: 'aa|bb' }));
    const p2 = await computeProof(key, parts({ channelBinding: 'aa|cc' }));
    expect(constantTimeEqual(p1, p2)).toBe(false);
  });

  it('differs when a nonce changes', async () => {
    const key = await deriveKey('secret9', new Uint8Array(16).fill(3), ITERS);
    const p1 = await computeProof(key, parts({ nonceH: new Uint8Array([1, 1]) }));
    const p2 = await computeProof(key, parts({ nonceH: new Uint8Array([2, 2]) }));
    expect(constantTimeEqual(p1, p2)).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for equal arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('returns false for differing content or length', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('validatePin', () => {
  it('accepts a reasonable pin', () => {
    expect(validatePin('4f9a2c')).toEqual({ ok: true });
    expect(validatePin('918273645')).toEqual({ ok: true });
  });

  it('rejects pins shorter than 6 chars', () => {
    expect(validatePin('12345').ok).toBe(false);
    expect(validatePin('').ok).toBe(false);
  });

  it('rejects all-same pins', () => {
    expect(validatePin('000000').ok).toBe(false);
    expect(validatePin('aaaaaa').ok).toBe(false);
  });

  it('rejects strictly sequential pins (ascending and descending)', () => {
    expect(validatePin('123456').ok).toBe(false);
    expect(validatePin('654321').ok).toBe(false);
    expect(validatePin('abcdef').ok).toBe(false);
  });
});

describe('verifier record', () => {
  it('round-trips through serialize/parse', async () => {
    const rec = await makeVerifier('s3cretpin', ITERS);
    expect(rec.alg).toBe('pbkdf2-sha256');
    expect(rec.iterations).toBe(ITERS);
    const round = parseVerifier(serializeVerifier(rec));
    expect(round).toEqual(rec);
  });

  it('does NOT contain the plaintext pin', async () => {
    const pin = 'topSecretPin42';
    const rec = await makeVerifier(pin, ITERS);
    const serialized = serializeVerifier(rec);
    expect(serialized.includes(pin)).toBe(false);
    expect(JSON.stringify(rec).includes(pin)).toBe(false);
  });

  it('rejects malformed verifier records', () => {
    expect(() => parseVerifier('{}')).toThrow();
    expect(() => parseVerifier('{"alg":"bad"}')).toThrow();
    expect(() => parseVerifier('not json')).toThrow();
  });

  it('uses the default iteration count when unspecified', async () => {
    const rec = await makeVerifier('uniqueDefaultPin');
    expect(rec.iterations).toBe(DEFAULT_PBKDF2_ITERATIONS);
  }, 30_000);
});

describe('verifyProofAgainst', () => {
  async function setup(pin: string) {
    const rec = await makeVerifier(pin, ITERS);
    const key = await deriveKey(pin, fromBase64(rec.salt), ITERS);
    return { rec, key };
  }

  it('accepts a correct proof', async () => {
    const { rec, key } = await setup('correctpin');
    const proof = await computeProof(key, parts());
    expect(await verifyProofAgainst(rec, proof, parts())).toBe(true);
  });

  it('rejects a proof from the wrong pin', async () => {
    const { rec } = await setup('correctpin');
    const wrongKey = await deriveKey('wrongpin', fromBase64(rec.salt), ITERS);
    const proof = await computeProof(wrongKey, parts());
    expect(await verifyProofAgainst(rec, proof, parts())).toBe(false);
  });

  it('rejects a replayed proof against a fresh host nonce', async () => {
    const { rec, key } = await setup('correctpin');
    const nonceH1 = randomBytes(32);
    const nonceH2 = randomBytes(32);
    const proofForH1 = await computeProof(key, parts({ nonceH: nonceH1 }));
    // Host issued a new challenge with nonceH2; the captured proof must fail.
    expect(await verifyProofAgainst(rec, proofForH1, parts({ nonceH: nonceH2 }))).toBe(false);
    // sanity: it still verifies against its own nonce
    expect(await verifyProofAgainst(rec, proofForH1, parts({ nonceH: nonceH1 }))).toBe(true);
  });

  it('rejects a proof for a different channel binding', async () => {
    const { rec, key } = await setup('correctpin');
    const proof = await computeProof(key, parts({ channelBinding: 'aa|bb' }));
    expect(await verifyProofAgainst(rec, proof, parts({ channelBinding: 'xx|yy' }))).toBe(false);
  });
});

describe('Peer.channelBindingFromSdp', () => {
  const fpA = 'a=fingerprint:sha-256 AA:BB:CC:DD';
  const fpB = 'a=fingerprint:sha-256 11:22:33:44';
  const sdp = (...lines: string[]) =>
    ['v=0', 'o=- 0 0 IN IP4 0.0.0.0', 's=-', ...lines].join('\r\n');

  it('is canonical regardless of local/remote ordering (swapped sides agree)', () => {
    // Host: local has fpA, remote has fpB. Viewer: local has fpB, remote has fpA.
    const host = Peer.channelBindingFromSdp(sdp(fpA), sdp(fpB));
    const viewer = Peer.channelBindingFromSdp(sdp(fpB), sdp(fpA));
    expect(host).toBe(viewer);
    expect(host).not.toBe('');
    expect(host.includes('|')).toBe(true);
  });

  it('is stable when fingerprints appear in swapped order within one SDP', () => {
    const one = Peer.channelBindingFromSdp(sdp(fpA, fpB), undefined);
    const two = Peer.channelBindingFromSdp(sdp(fpB, fpA), undefined);
    expect(one).toBe(two);
  });

  it('returns empty when fewer than two fingerprints are present', () => {
    expect(Peer.channelBindingFromSdp(sdp(fpA), undefined)).toBe('');
    expect(Peer.channelBindingFromSdp(undefined, undefined)).toBe('');
  });

  it('normalizes case so peers with different label casing still agree', () => {
    const upper = Peer.channelBindingFromSdp(sdp(fpA), sdp(fpB));
    const lower = Peer.channelBindingFromSdp(
      sdp('a=fingerprint:SHA-256 aa:bb:cc:dd'),
      sdp('a=fingerprint:SHA-256 11:22:33:44'),
    );
    expect(upper).toBe(lower);
  });
});
