/**
 * StreamScreen shared protocol contract.
 *
 * These types are the single source of truth shared by every package
 * (signaling, host, viewer, ai, e2e). They are intentionally dependency-free
 * so this module compiles and runs identically in the browser and in node.
 */

/** Which side of a session a peer is. */
export type Role = 'host' | 'viewer';

/**
 * A message exchanged over the WebSocket signaling channel.
 *
 * Signaling is only used to bootstrap the peer-to-peer WebRTC connection
 * (room join + SDP offer/answer + ICE candidates) and to enumerate LAN hosts.
 * Once the data/media channels are up, application traffic flows P2P and never
 * touches the signaling server.
 */
export interface SignalMessage {
  type:
    | 'join'
    | 'joined'
    | 'peer-joined'
    | 'peer-left'
    | 'offer'
    | 'answer'
    | 'ice'
    | 'error'
    | 'hosts'
    | 'ping'
    | 'pong';
  room?: string;
  code?: string;
  role?: Role;
  from?: string;
  to?: string;
  name?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  payload?: unknown;
  ts?: number;
  message?: string;
  /**
   * Optional ICE-server list the signaling server hands BOTH peers on the
   * `joined` acknowledgement so host and viewer negotiate against the SAME
   * STUN/TURN configuration (required for symmetric NAT traversal). OPT-IN and
   * additive: absent (or empty) means LAN-only with no ICE servers, the default
   * behavior. The operator configures these on the server (self-hosted coturn or
   * a STUN URL); see {@link parseIceServers}. Never carries third-party
   * defaults.
   */
  iceServers?: RTCIceServer[];
}

/**
 * A single remote-control input event sent over the WebRTC data channel from
 * viewer to host. Pointer coordinates are normalized 0..1 relative to the
 * remote screen so they are resolution-independent.
 *
 * `mods` is a bitflag set: 1 = shift, 2 = ctrl, 4 = alt, 8 = meta.
 */
export type InputEvent =
  | { t: 'm-move'; x: number; y: number }
  | { t: 'm-down'; x: number; y: number; button: 0 | 1 | 2 }
  | { t: 'm-up'; x: number; y: number; button: 0 | 1 | 2 }
  | { t: 'm-wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'k-down'; code: string; key: string; mods: number }
  | { t: 'k-up'; code: string; key: string; mods: number }
  | { t: 'clipboard'; text: string };

/**
 * A snapshot of live connection quality, gathered from the WebRTC stats API,
 * fed into the {@link AdaptiveController} each tick.
 */
export interface AdaptiveStats {
  rttMs: number;
  lossPct: number;
  jitterMs: number;
  availableKbps: number;
  fps: number;
  width: number;
  height: number;
  /**
   * Receiver-side jitter-buffer / playout delay in ms (delta-based average over
   * the last measurement window). This is the time a decoded frame waits in the
   * viewer's playout buffer before being rendered — pure receive-side queueing
   * that adds to end-to-end interactive latency on top of network `rttMs`.
   * 0 when unavailable (e.g. on the sender/host side, which has no inbound video).
   */
  playoutMs?: number;
  ts: number;
}

/**
 * The adaptive engine's decision for the next encoding period, applied to the
 * outbound video sender via `Peer.applyDecision`.
 */
export interface AdaptiveDecision {
  targetKbps: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  reason: string;
}

/** Public, discoverable description of an active host session. */
export interface SessionInfo {
  code: string;
  hostName: string;
  createdAt: number;
  viewers: number;
}

/** Valid {@link SignalMessage.type} discriminants. */
const SIGNAL_TYPES = new Set<SignalMessage['type']>([
  'join',
  'joined',
  'peer-joined',
  'peer-left',
  'offer',
  'answer',
  'ice',
  'error',
  'hosts',
  'ping',
  'pong',
]);

/** Valid {@link InputEvent.t} discriminants. */
const INPUT_TYPES = new Set<InputEvent['t']>([
  'm-move',
  'm-down',
  'm-up',
  'm-wheel',
  'k-down',
  'k-up',
  'clipboard',
]);

/** Runtime guard: is `v` a structurally-valid {@link SignalMessage}? */
export function isSignalMessage(v: unknown): v is SignalMessage {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const t = o.type;
  if (typeof t !== 'string' || !SIGNAL_TYPES.has(t as SignalMessage['type'])) return false;
  // Additive/backward-compatible: `iceServers` is optional, but when present it
  // must be a well-formed list so a malformed distribution can't leak through.
  if (o.iceServers !== undefined && !isIceServerList(o.iceServers)) return false;
  return true;
}

/**
 * Runtime guard for the optional {@link SignalMessage.iceServers} field: an array
 * of `RTCIceServer`-shaped objects, each with a string or string[] `urls` and
 * optional string `username`/`credential`. An empty array is valid (LAN-only).
 */
export function isIceServerList(v: unknown): v is RTCIceServer[] {
  if (!Array.isArray(v)) return false;
  return v.every(isIceServer);
}

/** Runtime guard for a single `RTCIceServer`. */
function isIceServer(v: unknown): v is RTCIceServer {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const urlsOk =
    typeof o.urls === 'string' ||
    (Array.isArray(o.urls) && o.urls.every((u) => typeof u === 'string'));
  if (!urlsOk) return false;
  if (o.username !== undefined && typeof o.username !== 'string') return false;
  if (o.credential !== undefined && typeof o.credential !== 'string') return false;
  return true;
}

/** Runtime guard: is `v` a structurally-valid {@link InputEvent}? */
export function isInputEvent(v: unknown): v is InputEvent {
  if (v === null || typeof v !== 'object') return false;
  const t = (v as { t?: unknown }).t;
  return typeof t === 'string' && INPUT_TYPES.has(t as InputEvent['t']);
}

/** A session code is 6–9 digits (no accounts, no relay — just this code gates a session). */
export function isValidSessionCode(code: string): boolean {
  return /^[0-9]{6,9}$/.test(code);
}

/**
 * Description of one capturable display on the host, advertised to the viewer
 * so it can offer a monitor picker and request a runtime switch.
 */
export interface MonitorInfo {
  id: string;
  name: string;
  primary: boolean;
  width: number;
  height: number;
}

/** Quality presets the viewer can request; mirrors the adaptive engine modes. */
export type QualityPreset = 'auto' | 'high' | 'balanced' | 'low';

/**
 * Application-level control messages exchanged over the reliable, ordered
 * `control` data channel (text JSON). This carries chat, multi-monitor
 * enumeration/switching, file-transfer signaling, audio toggling, and quality
 * preset selection — everything that is not raw {@link InputEvent} traffic and
 * not media. It never touches the signaling server; it flows peer-to-peer.
 */
export type ControlMessage =
  | { t: 'chat'; text: string; ts: number }
  | { t: 'monitors'; list: MonitorInfo[] }
  | { t: 'switch-monitor'; id: string }
  | { t: 'monitor-switched'; id: string }
  | { t: 'request-monitors' }
  | { t: 'file-offer'; id: string; name: string; size: number; mime: string }
  | { t: 'file-accept'; id: string }
  | { t: 'file-reject'; id: string }
  | { t: 'file-progress'; id: string; received: number }
  | { t: 'file-complete'; id: string }
  | { t: 'file-error'; id: string; message: string }
  | { t: 'audio'; enabled: boolean }
  | { t: 'quality'; preset: QualityPreset }
  | { t: 'latency'; rttMs: number; playoutMs: number; fps?: number }
  // ----- Connection-consent / access-PIN handshake (P2P over the encrypted
  // control channel; the signaling server never sees any of these fields). -----
  // Host -> viewer: present the challenge. `mode` tells the viewer what proof is
  // expected and is the single field that selects the variant shape:
  //
  //   - PIN modes ('pin' / 'pin-and-prompt'): the viewer must compute a PIN
  //     proof, so `salt`/`nonceH` (base64 binary) + `iterations` + the canonical
  //     DTLS-fingerprint `channelBinding` (see Peer.getChannelBinding) are ALL
  //     required. The host may re-send a fresh auth-challenge with a NEW `nonceH`
  //     to let a viewer retry after a failed-but-not-locked attempt (no new
  //     message type is needed for a retry — it is just another auth-challenge).
  //
  //   - Prompt mode ('prompt'): NO PIN proof is expected. The challenge exists
  //     only to flip the viewer into the "waiting for host approval" state while
  //     the host runs its consent gate, so the PIN fields are OPTIONAL and the
  //     host MAY omit them entirely.
  //
  // `mode` itself is OPTIONAL and defaults to 'pin' for backward compatibility
  // with peers that predate the explicit field (legacy senders only ever ran PIN
  // flows and always populated the PIN fields).
  | {
      t: 'auth-challenge';
      v: 1;
      mode?: 'pin' | 'pin-and-prompt';
      nonceH: string;
      salt: string;
      iterations: number;
      channelBinding: string;
    }
  | {
      t: 'auth-challenge';
      v: 1;
      mode: 'prompt';
      // PIN proof material is not required in prompt mode; the host may still
      // include it (older senders do), so it is permitted but optional.
      nonceH?: string;
      salt?: string;
      iterations?: number;
      channelBinding?: string;
    }
  // Viewer -> host: the response. `nonceV`/`proof` are base64 binary. `proof` is
  // the HMAC over (domain || nonceH || nonceV || channelBinding); omitted/empty
  // for prompt-only flows. `name` is an optional display name for the host UI.
  | { t: 'auth-response'; v: 1; nonceV: string; proof: string; name?: string }
  // Host -> viewer: the verdict. Intentionally REASON-FREE on failure so the
  // host never tells an attacker whether the PIN, the proof, or consent failed.
  | { t: 'auth-result'; v: 1; ok: boolean };

/** Valid {@link ControlMessage.t} discriminants. */
const CONTROL_TYPES = new Set<ControlMessage['t']>([
  'chat',
  'monitors',
  'switch-monitor',
  'monitor-switched',
  'request-monitors',
  'file-offer',
  'file-accept',
  'file-reject',
  'file-progress',
  'file-complete',
  'file-error',
  'audio',
  'quality',
  'latency',
  'auth-challenge',
  'auth-response',
  'auth-result',
]);

/** Valid access modes for the auth handshake `mode` field. */
const AUTH_MODES = new Set(['pin', 'pin-and-prompt', 'prompt']);

/** Valid {@link QualityPreset} values. */
const QUALITY_PRESETS = new Set<QualityPreset>(['auto', 'high', 'balanced', 'low']);

/**
 * Runtime guard: is `v` a structurally-valid {@link ControlMessage}?
 *
 * This validates not just the `t` discriminant but the required fields of each
 * variant, so a malformed frame off the wire is rejected rather than partially
 * trusted (the control channel drives file transfer and monitor switching).
 */
export function isControlMessage(v: unknown): v is ControlMessage {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const t = o.t;
  if (typeof t !== 'string' || !CONTROL_TYPES.has(t as ControlMessage['t'])) return false;
  const isStr = (x: unknown): x is string => typeof x === 'string';
  const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  switch (t as ControlMessage['t']) {
    case 'chat':
      return isStr(o.text) && isNum(o.ts);
    case 'monitors':
      return Array.isArray(o.list) && o.list.every(isMonitorInfo);
    case 'switch-monitor':
    case 'monitor-switched':
    case 'file-accept':
    case 'file-reject':
    case 'file-complete':
      return isStr(o.id);
    case 'request-monitors':
      return true;
    case 'file-offer':
      return isStr(o.id) && isStr(o.name) && isNum(o.size) && isStr(o.mime);
    case 'file-progress':
      return isStr(o.id) && isNum(o.received);
    case 'file-error':
      return isStr(o.id) && isStr(o.message);
    case 'audio':
      return typeof o.enabled === 'boolean';
    case 'quality':
      return isStr(o.preset) && QUALITY_PRESETS.has(o.preset as QualityPreset);
    case 'latency':
      // Viewer -> host real-time telemetry: rttMs and playoutMs are required
      // finite numbers; fps is optional but must be a finite number if present.
      return isNum(o.rttMs) && isNum(o.playoutMs) && (o.fps === undefined || isNum(o.fps));
    case 'auth-challenge': {
      if (o.v !== 1) return false;
      // `mode` is optional and defaults to 'pin' for back-compat; if present it
      // must be one of the known access modes.
      if (o.mode !== undefined && (!isStr(o.mode) || !AUTH_MODES.has(o.mode))) return false;
      const mode = o.mode === undefined ? 'pin' : o.mode;
      if (mode === 'prompt') {
        // Prompt mode carries no required PIN proof material — the challenge only
        // tells the viewer to show the "waiting for host approval" state. Any PIN
        // fields, if present, must still be well-typed (older senders include
        // them); but they may be omitted entirely.
        return (
          (o.nonceH === undefined || isStr(o.nonceH)) &&
          (o.salt === undefined || isStr(o.salt)) &&
          (o.iterations === undefined || isNum(o.iterations)) &&
          (o.channelBinding === undefined || isStr(o.channelBinding))
        );
      }
      // PIN modes ('pin' / 'pin-and-prompt'): full proof material is required.
      return (
        isStr(o.nonceH) &&
        isStr(o.salt) &&
        isNum(o.iterations) &&
        isStr(o.channelBinding)
      );
    }
    case 'auth-response':
      return (
        o.v === 1 &&
        isStr(o.nonceV) &&
        isStr(o.proof) &&
        (o.name === undefined || isStr(o.name))
      );
    case 'auth-result':
      return o.v === 1 && typeof o.ok === 'boolean';
    default:
      return false;
  }
}

/** Runtime guard for a single {@link MonitorInfo}. */
function isMonitorInfo(v: unknown): v is MonitorInfo {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.primary === 'boolean' &&
    typeof o.width === 'number' &&
    Number.isFinite(o.width) &&
    typeof o.height === 'number' &&
    Number.isFinite(o.height)
  );
}

/**
 * Modifier bitflags used by {@link InputEvent} `k-down`/`k-up`.
 * Mirrors the documented `mods` set on the input protocol.
 */
export const KEY_MODS = {
  shift: 1,
  ctrl: 2,
  alt: 4,
  meta: 8,
} as const;

/** A logical name (modifier or key) understood by {@link buildKeyCombo}. */
export type ComboKey =
  | 'shift'
  | 'ctrl'
  | 'control'
  | 'alt'
  | 'meta'
  | 'win'
  | 'super'
  | 'cmd'
  | string;

/** Map a friendly modifier name to its {@link KEY_MODS} bitflag (0 if not a modifier). */
function modFlagFor(name: string): number {
  switch (name.toLowerCase()) {
    case 'shift':
      return KEY_MODS.shift;
    case 'ctrl':
    case 'control':
      return KEY_MODS.ctrl;
    case 'alt':
      return KEY_MODS.alt;
    case 'meta':
    case 'win':
    case 'super':
    case 'cmd':
      return KEY_MODS.meta;
    default:
      return 0;
  }
}

/** Resolve the `{ code, key }` pair an injector expects for a logical key name. */
function codeKeyFor(name: string): { code: string; key: string } {
  const n = name.toLowerCase();
  switch (n) {
    case 'shift':
      return { code: 'ShiftLeft', key: 'Shift' };
    case 'ctrl':
    case 'control':
      return { code: 'ControlLeft', key: 'Control' };
    case 'alt':
      return { code: 'AltLeft', key: 'Alt' };
    case 'meta':
    case 'win':
    case 'super':
    case 'cmd':
      return { code: 'MetaLeft', key: 'Meta' };
    case 'delete':
    case 'del':
      return { code: 'Delete', key: 'Delete' };
    case 'escape':
    case 'esc':
      return { code: 'Escape', key: 'Escape' };
    case 'tab':
      return { code: 'Tab', key: 'Tab' };
    case 'enter':
    case 'return':
      return { code: 'Enter', key: 'Enter' };
    default: {
      // Single printable character → letter/digit code; otherwise pass through.
      if (name.length === 1) {
        const upper = name.toUpperCase();
        if (upper >= 'A' && upper <= 'Z') return { code: `Key${upper}`, key: name };
        if (name >= '0' && name <= '9') return { code: `Digit${name}`, key: name };
      }
      return { code: name, key: name };
    }
  }
}

/**
 * Build an ordered sequence of {@link InputEvent}s for a key combination.
 *
 * The combo is expressed as a list of logical key names; trailing modifiers and
 * keys are pressed in order (each `k-down`), with the cumulative modifier
 * bitmask applied to every event, then released in reverse order (each `k-up`).
 * This produces the correct chord semantics for things like Ctrl+Alt+Del or
 * Win+R on the host injector, which honors the `mods` bitfield.
 *
 * @example buildKeyCombo(['ctrl','alt','delete'])
 */
export function buildKeyCombo(keys: string[]): InputEvent[] {
  if (keys.length === 0) return [];
  // Accumulate the modifier mask from any modifier keys in the chord so the
  // host sees, e.g., Ctrl+Alt held while Delete is pressed.
  let mods = 0;
  for (const k of keys) mods |= modFlagFor(k);

  const down: InputEvent[] = [];
  const up: InputEvent[] = [];
  for (const name of keys) {
    const { code, key } = codeKeyFor(name);
    down.push({ t: 'k-down', code, key, mods });
    up.unshift({ t: 'k-up', code, key, mods });
  }
  return [...down, ...up];
}

/** The classic Secure Attention Sequence: Ctrl+Alt+Del, as an ordered event list. */
export const CTRL_ALT_DEL: InputEvent[] = buildKeyCombo(['ctrl', 'alt', 'delete']);

/** Ready-made combos for the common special chords a viewer exposes. */
export const SPECIAL_KEYS = {
  CTRL_ALT_DEL,
  WIN: buildKeyCombo(['win']),
  ALT_TAB: buildKeyCombo(['alt', 'tab']),
  WIN_R: buildKeyCombo(['win', 'r']),
  WIN_D: buildKeyCombo(['win', 'd']),
  ALT_F4: buildKeyCombo(['alt', 'F4']),
  ESCAPE: buildKeyCombo(['escape']),
} as const;
