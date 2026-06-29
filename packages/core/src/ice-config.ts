/**
 * StreamScreen ICE-server configuration parsing.
 *
 * "Connect from anywhere" is an OPT-IN, still-self-hostable feature: the
 * operator supplies their own STUN URL and/or self-hosted TURN server (e.g.
 * coturn). Nothing here is hardcoded and no third-party server is contacted —
 * absent any configuration the result is `[]` and the WebRTC layer stays
 * LAN-only.
 *
 * {@link parseIceServers} is a pure, dependency-free, cross-env parser that
 * accepts either machine-friendly JSON or a compact human-friendly string, and
 * NEVER throws on user input (garbage in → `[]` / dropped entries). Both peers
 * must end up with the SAME list, so the signaling server distributes the
 * parsed list to host and viewer alike via the `joined` ack.
 */

/** The ICE schemes StreamScreen understands. */
const ICE_SCHEMES = ['stun', 'stuns', 'turn', 'turns'] as const;
type IceScheme = (typeof ICE_SCHEMES)[number];

/** A scheme that carries (optionally) credentials. */
function schemeUsesCreds(scheme: IceScheme): boolean {
  return scheme === 'turn' || scheme === 'turns';
}

/**
 * Parse operator-supplied ICE-server configuration into a normalized
 * `RTCIceServer[]`, accepting BOTH input shapes:
 *
 * 1. A JSON array of `RTCIceServer` objects (or a value that is already such an
 *    array — handy when config is loaded from a parsed file), e.g.
 *    `[{"urls":"stun:stun.example.com:3478"},
 *      {"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`
 *
 * 2. A compact, human-friendly comma/whitespace-separated list of URLs with
 *    optional inline credentials, e.g.
 *    `"stun:stun.example.com:3478,
 *      turn:user:pass@turn.example.com:3478,
 *      turns:user:pass@turn.example.com:5349"`
 *    where `turn(s):user:pass@host:port` →
 *    `{ urls:'turn(s):host:port', username:'user', credential:'pass' }` and
 *    `stun:host:port` → `{ urls:'stun:host:port' }`.
 *
 * Blank, malformed, or unknown-scheme entries are skipped gracefully. Empty or
 * unparseable input yields `[]`. This function never throws.
 */
export function parseIceServers(input: unknown): RTCIceServer[] {
  if (input == null) return [];

  // Already an array (JSON form passed pre-parsed, or distributed over the wire).
  if (Array.isArray(input)) {
    return normalizeArray(input);
  }

  if (typeof input !== 'string') return [];

  const trimmed = input.trim();
  if (trimmed === '') return [];

  // JSON form: a string that parses to an array of RTCIceServer objects.
  if (trimmed.startsWith('[')) {
    const parsed = tryJson(trimmed);
    if (Array.isArray(parsed)) return normalizeArray(parsed);
    // A bracketed string that is not valid JSON: fall through to compact parsing
    // would be meaningless, so treat as garbage.
    return [];
  }

  // Compact form: comma- and/or whitespace-separated URLs with optional creds.
  return parseCompact(trimmed);
}

/** Best-effort JSON parse that swallows errors (returns `undefined` on failure). */
function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Normalize an array of candidate `RTCIceServer` objects: keep only entries with
 * at least one valid, known-scheme URL; coerce `urls` (string or string[]) and
 * carry through `username`/`credential` when present.
 */
function normalizeArray(arr: unknown[]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const entry of arr) {
    const server = normalizeServer(entry);
    if (server) out.push(server);
  }
  return out;
}

/** Normalize one candidate `RTCIceServer` object, or `null` if unusable. */
function normalizeServer(entry: unknown): RTCIceServer | null {
  if (entry === null || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;

  const rawUrls = o.urls;
  const urlList: string[] = [];
  if (typeof rawUrls === 'string') {
    if (isValidIceUrl(rawUrls)) urlList.push(normalizeUrl(rawUrls));
  } else if (Array.isArray(rawUrls)) {
    for (const u of rawUrls) {
      if (typeof u === 'string' && isValidIceUrl(u)) urlList.push(normalizeUrl(u));
    }
  }
  if (urlList.length === 0) return null;

  const server: RTCIceServer = { urls: urlList.length === 1 ? urlList[0] : urlList };
  if (typeof o.username === 'string' && o.username !== '') server.username = o.username;
  if (typeof o.credential === 'string' && o.credential !== '') {
    server.credential = o.credential;
  }
  return server;
}

/** Parse the compact comma/whitespace-separated URL form into `RTCIceServer[]`. */
function parseCompact(input: string): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  // Split on commas and any run of whitespace; drop empty tokens.
  for (const token of input.split(/[\s,]+/)) {
    const entry = token.trim();
    if (entry === '') continue;
    const server = parseCompactEntry(entry);
    if (server) out.push(server);
  }
  return out;
}

/**
 * Parse one compact entry. Forms accepted:
 *   stun:host:port           → { urls:'stun:host:port' }
 *   turn:host:port           → { urls:'turn:host:port' }
 *   turn:user:pass@host:port → { urls:'turn:host:port', username, credential }
 * Returns `null` for blanks, unknown schemes, or missing host.
 */
function parseCompactEntry(entry: string): RTCIceServer | null {
  const colon = entry.indexOf(':');
  if (colon <= 0) return null;
  const scheme = entry.slice(0, colon).toLowerCase();
  if (!isIceScheme(scheme)) return null;
  let rest = entry.slice(colon + 1);
  if (rest === '') return null;

  let username: string | undefined;
  let credential: string | undefined;

  // Inline creds (turn/turns only): user:pass@host:port. Split on the LAST '@'
  // so a password containing '@' would still need encoding, but a host never
  // does; the last '@' reliably separates creds from the authority.
  if (schemeUsesCreds(scheme)) {
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      const creds = rest.slice(0, at);
      rest = rest.slice(at + 1);
      const sep = creds.indexOf(':');
      if (sep >= 0) {
        username = creds.slice(0, sep);
        credential = creds.slice(sep + 1);
      } else {
        username = creds;
      }
    }
  }

  const host = rest.trim();
  if (host === '') return null;

  const server: RTCIceServer = { urls: `${scheme}:${host}` };
  if (username !== undefined && username !== '') server.username = username;
  if (credential !== undefined && credential !== '') server.credential = credential;
  return server;
}

/** Is `s` one of the ICE schemes we understand? */
function isIceScheme(s: string): s is IceScheme {
  return (ICE_SCHEMES as readonly string[]).includes(s);
}

/** Validate that a full URL string starts with a known ICE scheme and a host. */
function isValidIceUrl(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon <= 0) return false;
  const scheme = url.slice(0, colon).toLowerCase();
  if (!isIceScheme(scheme)) return false;
  return url.slice(colon + 1).trim() !== '';
}

/** Lowercase the scheme of an already-valid ICE URL, preserving the authority. */
function normalizeUrl(url: string): string {
  const colon = url.indexOf(':');
  return `${url.slice(0, colon).toLowerCase()}:${url.slice(colon + 1).trim()}`;
}

/**
 * Serialize an `RTCIceServer[]` back into the compact human-friendly string form
 * (the inverse of the compact branch of {@link parseIceServers}). Useful for
 * round-tripping config or logging. TURN credentials are inlined as
 * `scheme:user:pass@host:port`. Multi-URL entries expand to one token each.
 */
export function serializeIceServers(servers: RTCIceServer[]): string {
  const tokens: string[] = [];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (typeof url !== 'string' || url === '') continue;
      const colon = url.indexOf(':');
      if (colon <= 0) continue;
      const scheme = url.slice(0, colon).toLowerCase();
      const authority = url.slice(colon + 1);
      const username = typeof server.username === 'string' ? server.username : '';
      const credential = typeof server.credential === 'string' ? server.credential : '';
      if (schemeUsesCreds(scheme as IceScheme) && username !== '') {
        const creds = credential !== '' ? `${username}:${credential}` : username;
        tokens.push(`${scheme}:${creds}@${authority}`);
      } else {
        tokens.push(`${scheme}:${authority}`);
      }
    }
  }
  return tokens.join(', ');
}
