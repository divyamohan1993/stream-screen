/**
 * StreamScreen cross-environment authentication primitives.
 *
 * This module implements the cryptographic core of the connection-consent /
 * access-PIN feature. It runs IDENTICALLY in node and in the browser with ZERO
 * new dependencies: it prefers `node:crypto` (resolved via a dynamic import,
 * guarded by a `typeof` check) and otherwise falls back to the WebCrypto
 * `globalThis.crypto.subtle` API.
 *
 * ZERO-TRUST: none of these values ever transit the signaling server. The PIN
 * is verified peer-to-peer over the encrypted DTLS data channel. The host
 * persists only a PBKDF2 VERIFIER (salt + derived key) — never the PIN, never a
 * reversible form of it. PIN entropy is low, so the verifier exists purely so a
 * host can recompute the expected proof; brute-force resistance comes from the
 * 600k-iteration KDF plus the connection-layer lockout (implemented elsewhere).
 *
 * PROOF binds: a domain-separation tag, the host nonce, the viewer nonce, and a
 * DTLS channel-binding string (see {@link Peer.getChannelBinding}). Binding the
 * DTLS fingerprints means a man-in-the-middle that re-terminates DTLS computes a
 * different channel binding and therefore a non-matching proof — the auth fails.
 */

/** Domain-separation tag mixed into every proof. Bump on any wire change. */
export const AUTH_DOMAIN = 'streamscreen-auth-v1';

/** Default PBKDF2 iteration count (OWASP 2025 guidance for PBKDF2-HMAC-SHA256). */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/** Random salt length in bytes. */
export const SALT_BYTES = 16;

/** Derived key / nonce length in bytes. */
export const KEY_BYTES = 32;

/** Length in bytes of the per-handshake nonces. */
export const NONCE_BYTES = 32;

/**
 * Persisted, non-reversible authentication material for a single configured PIN.
 *
 * Stored by the host (e.g. in its config). Contains only the PBKDF2 salt and the
 * derived key (both base64) — the plaintext PIN cannot be recovered from this
 * without brute-forcing the KDF, which is why the iteration count is high.
 */
export interface VerifierRecord {
  alg: 'pbkdf2-sha256';
  iterations: number;
  /** base64-encoded 16-byte salt. */
  salt: string;
  /** base64-encoded 32-byte derived key. */
  key: string;
}

/** Inputs bound into a proof, identical on both peers for a given handshake. */
export interface ProofParts {
  domain: string;
  nonceH: Uint8Array;
  nonceV: Uint8Array;
  channelBinding: string;
}

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

/** Minimal shape of the parts of `node:crypto` we use. */
interface NodeCryptoLike {
  randomBytes(n: number): { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  pbkdf2(
    password: string | Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    cb: (err: Error | null, derived: Uint8Array) => void,
  ): void;
  createHmac(alg: string, key: Uint8Array): {
    update(data: Uint8Array): unknown;
    digest(): Uint8Array;
  };
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

let nodeCryptoCache: NodeCryptoLike | null | undefined;

/**
 * Resolve `node:crypto` if we are in a node-like runtime, else `null`.
 *
 * Cached after the first call. Uses a dynamic import behind a `process` check so
 * bundlers building for the browser never try to resolve the node builtin.
 */
async function getNodeCrypto(): Promise<NodeCryptoLike | null> {
  if (nodeCryptoCache !== undefined) return nodeCryptoCache;
  try {
    const hasProcess =
      typeof process !== 'undefined' &&
      !!(process as { versions?: { node?: string } }).versions?.node;
    if (!hasProcess) {
      nodeCryptoCache = null;
      return null;
    }
    const mod = (await import('node:crypto')) as unknown as NodeCryptoLike;
    nodeCryptoCache = mod && typeof mod.pbkdf2 === 'function' ? mod : null;
  } catch {
    nodeCryptoCache = null;
  }
  return nodeCryptoCache;
}

/** Resolve a WebCrypto `SubtleCrypto`, or throw if no CSPRNG/subtle is present. */
function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error('No WebCrypto subtle available and node:crypto not found');
  }
  return c.subtle;
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/**
 * Cryptographically-secure random bytes.
 *
 * Synchronous: uses `globalThis.crypto.getRandomValues` when present (available
 * in modern node and all browsers), else falls back to `node:crypto`'s sync
 * `randomBytes` resolved lazily via `require` when import is unavailable.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  // Last-resort node fallback when WebCrypto's getRandomValues is unavailable.
  if (nodeCryptoCache) {
    const buf = nodeCryptoCache.randomBytes(n);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw new Error('No CSPRNG available (crypto.getRandomValues missing)');
}

// ---------------------------------------------------------------------------
// Base64 helpers (env-agnostic, no Buffer/atob assumptions)
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: number[] = (() => {
  const t = new Array<number>(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/** Encode bytes as standard (padded) base64 — works in node and browser. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Decode standard base64 to bytes. Throws on invalid input. */
export function fromBase64(b64: string): Uint8Array {
  const s = b64.replace(/=+$/, '');
  const outLen = Math.floor((s.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_LOOKUP[s.charCodeAt(i)];
    if (v < 0) throw new Error('Invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** UTF-8 encode a string to bytes (TextEncoder is available in node & browser). */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Concatenate byte arrays into one. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// KDF + proof
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte key from a PIN and salt using PBKDF2-HMAC-SHA256.
 *
 * Identical output in node (`crypto.pbkdf2`) and browser (`subtle.deriveBits`)
 * for the same `(pin, salt, iterations)`.
 */
export async function deriveKey(
  pin: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const node = await getNodeCrypto();
  if (node) {
    return await new Promise<Uint8Array>((resolve, reject) => {
      node.pbkdf2(utf8(pin), salt, iterations, KEY_BYTES, 'sha256', (err, derived) => {
        if (err) reject(err);
        else resolve(new Uint8Array(derived.buffer, derived.byteOffset, derived.byteLength));
      });
    });
  }
  const subtle = getSubtle();
  const baseKey = await subtle.importKey(
    'raw',
    utf8(pin) as unknown as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Compute HMAC-SHA256(key, data) in either environment. */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const node = await getNodeCrypto();
  if (node) {
    const h = node.createHmac('sha256', key);
    h.update(data);
    const d = h.digest();
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  }
  const subtle = getSubtle();
  const cryptoKey = await subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, data as unknown as BufferSource);
  return new Uint8Array(sig);
}

/** Build the byte string a proof HMACs over: domain || nonceH || nonceV || utf8(channelBinding). */
function proofMessage(parts: ProofParts): Uint8Array {
  return concatBytes(utf8(parts.domain), parts.nonceH, parts.nonceV, utf8(parts.channelBinding));
}

/**
 * Compute a proof: HMAC-SHA256(derivedKey, domain || nonceH || nonceV || cb).
 *
 * Both peers derive the same key from the PIN and compute over the same bound
 * inputs, so the viewer's proof equals the host's recomputed expectation iff the
 * PIN matches and the channel binding (DTLS fingerprints) agrees.
 */
export async function computeProof(key: Uint8Array, parts: ProofParts): Promise<Uint8Array> {
  return await hmacSha256(key, proofMessage(parts));
}

// ---------------------------------------------------------------------------
// Constant-time compare
// ---------------------------------------------------------------------------

/**
 * Constant-time byte-array equality.
 *
 * Uses node's `timingSafeEqual` when available; otherwise a length-safe JS
 * fallback that always scans a fixed number of bytes and never short-circuits,
 * so it does not leak match position or (for equal-length inputs) match length
 * through timing. Differing lengths return false.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  if (nodeCryptoCache && typeof nodeCryptoCache.timingSafeEqual === 'function') {
    try {
      return nodeCryptoCache.timingSafeEqual(a, b);
    } catch {
      // fall through to JS impl on any mismatch the native fn dislikes
    }
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PIN policy
// ---------------------------------------------------------------------------

/** Minimum acceptable PIN length. */
export const MIN_PIN_LENGTH = 6;

/** True if every character of `s` is identical (e.g. "000000"). */
function isAllSame(s: string): boolean {
  for (let i = 1; i < s.length; i++) if (s[i] !== s[0]) return false;
  return true;
}

/**
 * True if `s` is a strictly monotonic run of adjacent code points, ascending or
 * descending (e.g. "123456", "654321", "abcdef"). These are trivially guessable.
 */
function isStrictlySequential(s: string): boolean {
  if (s.length < 2) return false;
  const step = s.charCodeAt(1) - s.charCodeAt(0);
  if (step !== 1 && step !== -1) return false;
  for (let i = 1; i < s.length; i++) {
    if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== step) return false;
  }
  return true;
}

/**
 * Validate a candidate PIN against the minimum policy: at least
 * {@link MIN_PIN_LENGTH} characters, not all-identical, not a strictly
 * sequential run. Returns a machine-readable `reason` on rejection (the reason
 * is for the host configuring its own PIN — it is never sent to a viewer).
 */
export function validatePin(pin: string): { ok: boolean; reason?: string } {
  if (typeof pin !== 'string' || pin.length < MIN_PIN_LENGTH) {
    return { ok: false, reason: 'too-short' };
  }
  if (isAllSame(pin)) return { ok: false, reason: 'all-same' };
  if (isStrictlySequential(pin)) return { ok: false, reason: 'sequential' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Verifier record
// ---------------------------------------------------------------------------

/**
 * Create a persistable {@link VerifierRecord} for a PIN: a fresh random salt
 * plus the PBKDF2-derived key (both base64). The plaintext PIN is NOT stored and
 * cannot be recovered without brute-forcing the KDF.
 */
export async function makeVerifier(
  pin: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<VerifierRecord> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(pin, salt, iterations);
  return {
    alg: 'pbkdf2-sha256',
    iterations,
    salt: toBase64(salt),
    key: toBase64(key),
  };
}

/** Serialize a {@link VerifierRecord} to a JSON string for storage. */
export function serializeVerifier(record: VerifierRecord): string {
  return JSON.stringify(record);
}

/** Parse a serialized {@link VerifierRecord}. Throws on malformed/invalid input. */
export function parseVerifier(s: string): VerifierRecord {
  const o = JSON.parse(s) as Partial<VerifierRecord>;
  if (
    !o ||
    o.alg !== 'pbkdf2-sha256' ||
    typeof o.iterations !== 'number' ||
    !Number.isFinite(o.iterations) ||
    o.iterations <= 0 ||
    typeof o.salt !== 'string' ||
    typeof o.key !== 'string'
  ) {
    throw new Error('Invalid verifier record');
  }
  // Validate base64 fields decode.
  fromBase64(o.salt);
  fromBase64(o.key);
  return { alg: o.alg, iterations: o.iterations, salt: o.salt, key: o.key };
}

/**
 * Verify a viewer-supplied `proof` against a host's {@link VerifierRecord}.
 *
 * Recomputes the expected HMAC from the stored derived key (`record.key`) over
 * the SAME bound inputs and constant-time compares. Returns false (fail-closed)
 * on any decode/compute error. Because the proof binds the host nonce, a proof
 * captured for one challenge cannot be replayed against a fresh challenge that
 * uses a new `nonceH` — the recomputed expectation differs.
 */
export async function verifyProofAgainst(
  record: VerifierRecord,
  proof: Uint8Array,
  parts: ProofParts,
): Promise<boolean> {
  try {
    const key = fromBase64(record.key);
    const expected = await computeProof(key, parts);
    return constantTimeEqual(expected, proof);
  } catch {
    return false;
  }
}

/**
 * Eagerly resolve `node:crypto` so the synchronous {@link randomBytes} and
 * {@link constantTimeEqual} can prefer the native implementation when WebCrypto
 * is absent. Idempotent; safe to call (and await) at startup. Returns true when
 * node:crypto is available.
 */
export async function initCryptoBackend(): Promise<boolean> {
  return (await getNodeCrypto()) !== null;
}
