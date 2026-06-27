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
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && SIGNAL_TYPES.has(t as SignalMessage['type']);
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
