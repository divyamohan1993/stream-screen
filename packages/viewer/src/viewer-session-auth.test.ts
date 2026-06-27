import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ControlMessage,
  InputEvent,
  AdaptiveStats,
  VerifierRecord,
} from '@stream-screen/core';

/**
 * Viewer-side connection-consent / access-PIN tests.
 *
 * We mock core's `Peer`/`SignalingClient` so the session runs without real
 * WebRTC, but use the REAL core crypto helpers (`makeVerifier`,
 * `verifyProofAgainst`, base64) so the proof the viewer sends is verified
 * end-to-end against a host-side verifier built from the same PIN — exactly as
 * the host would, over the encrypted control channel. The signaling server is
 * never involved in the secret (these tests don't route auth through it).
 */

type StateCb = (s: RTCPeerConnectionState) => void;
type TrackCb = (track: MediaStreamTrack, stream: MediaStream) => void;

/**
 * A controllable channel binding both peers must agree on for the proof.
 * Declared as a hoisted `function` (not a `const`) so it is safe to reference
 * from {@link FakePeer}, which the hoisted `vi.mock` factory captures.
 */
function channelBinding(): string {
  return 'sha-256 AA:BB|sha-256 CC:DD';
}
const CHANNEL_BINDING = channelBinding();

class FakePeer {
  static current: FakePeer | null = null;
  controlCb: ((m: ControlMessage) => void) | null = null;
  stateCb: StateCb | null = null;
  trackCb: TrackCb | null = null;
  sentControl: ControlMessage[] = [];

  constructor() {
    FakePeer.current = this;
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'state') this.stateCb = cb as StateCb;
    if (ev === 'track') this.trackCb = cb as TrackCb;
  }
  async start(): Promise<void> {}
  async getStats(): Promise<AdaptiveStats> {
    return {
      rttMs: 0,
      lossPct: 0,
      jitterMs: 0,
      availableKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
      playoutMs: 0,
      ts: Date.now(),
    };
  }
  sendControl(m: ControlMessage): void {
    this.sentControl.push(m);
  }
  onControl(cb: (m: ControlMessage) => void): void {
    this.controlCb = cb;
  }
  onFileChunk(_cb: (b: ArrayBuffer) => void): void {}
  onInput(_cb: (e: InputEvent) => void): void {}
  sendInput(): void {}
  sendFileChunk(): void {}
  async drainFile(): Promise<void> {}
  getChannelBinding(): string {
    return channelBinding();
  }
  close(): void {}

  /** Drive the peer to the WebRTC `connected` state. */
  goConnected(): void {
    this.stateCb?.('connected');
  }
  /** Deliver an inbound control frame to the session. */
  deliver(m: ControlMessage): void {
    this.controlCb?.(m);
  }
  /** Emit a remote track + stream. */
  emitStream(stream: MediaStream): void {
    this.trackCb?.({} as MediaStreamTrack, stream);
  }
}

class FakeSignaling {
  private handlers = new Map<string, (m: unknown) => void>();
  on(ev: string, cb: (m: unknown) => void): void {
    this.handlers.set(ev, cb);
  }
  off(): void {}
  async connect(): Promise<void> {}
  join(): void {
    this.handlers.get('joined')?.({ type: 'joined' });
  }
  close(): void {}
}

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: FakeSignaling };
});

const { ViewerSession } = await import('./viewer-session.js');
// Import the REAL core crypto helpers (the mock spreads `...actual`, so these
// resolve to the genuine implementations even though core is mocked). Done
// dynamically so the top-level static import doesn't force the hoisted vi.mock
// factory to run before the fake classes are initialized.
const {
  makeVerifier,
  verifyProofAgainst,
  fromBase64,
  toBase64,
  randomBytes,
  AUTH_DOMAIN,
  NONCE_BYTES,
} = await import('@stream-screen/core');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;
type AuthChallenge = import('./viewer-session.js').AuthChallenge;

const PIN = '824193';

/** Build a host-side `auth-challenge` for a given verifier + mode. */
function challengeFor(
  verifier: VerifierRecord,
  mode: 'pin' | 'pin-and-prompt' | 'prompt',
  nonceH: Uint8Array,
): Extract<ControlMessage, { t: 'auth-challenge' }> {
  return {
    t: 'auth-challenge',
    v: 1,
    nonceH: toBase64(nonceH),
    salt: verifier.salt,
    iterations: verifier.iterations,
    channelBinding: CHANNEL_BINDING,
    mode,
  };
}

async function connectedSession(handlers: Handlers = {}) {
  const session = new ViewerSession({
    code: '123456',
    signalingUrl: 'ws://x:8787',
    name: 'tester',
    handlers,
  });
  await session.connect();
  FakePeer.current!.goConnected();
  return session;
}

describe('ViewerSession auth (consent + PIN)', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('open mode: no challenge — connects and renders video normally', async () => {
    const states: string[] = [];
    let streamed: MediaStream | null = null;
    await connectedSession({
      onState: (s) => states.push(s),
      onStream: (s) => (streamed = s),
      onAuthRequired: () => {
        throw new Error('onAuthRequired must NOT fire in open mode');
      },
    });
    const peer = FakePeer.current!;
    const stream = {} as MediaStream;
    peer.emitStream(stream);
    // No auth -> connected and the stream passes straight through.
    expect(states).toContain('connected');
    expect(streamed).toBe(stream);
  });

  it('pin mode: viewer proof VERIFIES against a host verifier built from the same PIN', async () => {
    const verifier = await makeVerifier(PIN, 1000); // low iterations: fast test
    const nonceH = randomBytes(NONCE_BYTES);

    let challenge: AuthChallenge | null = null;
    const session = await connectedSession({ onAuthRequired: (c) => (challenge = c) });
    const peer = FakePeer.current!;

    peer.deliver(challengeFor(verifier, 'pin', nonceH));
    expect(challenge).toEqual({ mode: 'pin', needsPin: true });
    // Lifecycle is GATED at 'authenticating', not 'connected'.
    expect(session.currentState).toBe('authenticating');
    // No response sent yet (PIN not entered).
    expect(peer.sentControl.find((m) => m.t === 'auth-response')).toBeUndefined();

    await session.submitPin(PIN);

    const resp = peer.sentControl.find((m) => m.t === 'auth-response') as Extract<
      ControlMessage,
      { t: 'auth-response' }
    >;
    expect(resp).toBeDefined();
    expect(resp.name).toBe('tester');

    // Host-side verification of the exact proof the viewer sent.
    const ok = await verifyProofAgainst(verifier, fromBase64(resp.proof), {
      domain: AUTH_DOMAIN,
      nonceH,
      nonceV: fromBase64(resp.nonceV),
      channelBinding: CHANNEL_BINDING,
    });
    expect(ok).toBe(true);
  });

  it('pin mode: a WRONG pin produces a proof the host verifier REJECTS', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);

    const session = await connectedSession();
    const peer = FakePeer.current!;
    peer.deliver(challengeFor(verifier, 'pin', nonceH));

    await session.submitPin('000999'); // wrong

    const resp = peer.sentControl.find((m) => m.t === 'auth-response') as Extract<
      ControlMessage,
      { t: 'auth-response' }
    >;
    const ok = await verifyProofAgainst(verifier, fromBase64(resp.proof), {
      domain: AUTH_DOMAIN,
      nonceH,
      nonceV: fromBase64(resp.nonceV),
      channelBinding: CHANNEL_BINDING,
    });
    expect(ok).toBe(false);
  });

  it('prompt mode: shows the waiting state and sends a PROOF-LESS response', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);
    let challenge: AuthChallenge | null = null;
    const session = await connectedSession({ onAuthRequired: (c) => (challenge = c) });
    const peer = FakePeer.current!;

    peer.deliver(challengeFor(verifier, 'prompt', nonceH));
    expect(challenge).toEqual({ mode: 'prompt', needsPin: false });
    expect(session.currentState).toBe('authenticating');

    // Prompt-only auto-sends a response with NO proof (just a nonce + name).
    const resp = peer.sentControl.find((m) => m.t === 'auth-response') as Extract<
      ControlMessage,
      { t: 'auth-response' }
    >;
    expect(resp).toBeDefined();
    expect(resp.proof).toBe('');
    expect(resp.name).toBe('tester');
  });

  it('auth-result false -> denied state; true -> connected', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);
    const results: boolean[] = [];
    const session = await connectedSession({ onAuthResult: (ok) => results.push(ok) });
    const peer = FakePeer.current!;

    peer.deliver(challengeFor(verifier, 'pin', nonceH));
    await session.submitPin(PIN);

    peer.deliver({ t: 'auth-result', v: 1, ok: false });
    expect(results).toEqual([false]);
    expect(session.currentState).toBe('denied');

    // Retry then succeed.
    await session.submitPin(PIN);
    peer.deliver({ t: 'auth-result', v: 1, ok: true });
    expect(results).toEqual([false, true]);
    expect(session.currentState).toBe('connected');
  });

  it('video is GATED until auth-result ok, then released', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);
    let streamed: MediaStream | null = null;
    const session = await connectedSession({ onStream: (s) => (streamed = s) });
    const peer = FakePeer.current!;

    peer.deliver(challengeFor(verifier, 'pin', nonceH));
    // A stream arriving while gated must NOT be surfaced.
    const stream = {} as MediaStream;
    peer.emitStream(stream);
    expect(streamed).toBeNull();
    expect(session.currentState).toBe('authenticating');

    await session.submitPin(PIN);
    expect(streamed).toBeNull(); // still gated until the host verdict

    peer.deliver({ t: 'auth-result', v: 1, ok: true });
    // Released on authorization.
    expect(streamed).toBe(stream);
    expect(session.currentState).toBe('connected');
  });

  it('does not store the PIN and computes the channel binding locally', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);
    const session = await connectedSession();
    const peer = FakePeer.current!;
    const bindingSpy = vi.spyOn(peer, 'getChannelBinding');

    peer.deliver(challengeFor(verifier, 'pin', nonceH));
    await session.submitPin(PIN);

    // The binding was taken from the local peer (never trusted from the wire).
    expect(bindingSpy).toHaveBeenCalled();
    // No field anywhere on the session retains the plaintext PIN. Walk reachable
    // own-string properties (cycle-safe) and assert none equals/contains the PIN.
    const seen = new Set<unknown>();
    const containsPin = (obj: unknown, depth: number): boolean => {
      if (depth > 6 || obj == null) return false;
      if (typeof obj === 'string') return obj.includes(PIN);
      if (typeof obj !== 'object') return false;
      if (seen.has(obj)) return false;
      seen.add(obj);
      for (const v of Object.values(obj as Record<string, unknown>)) {
        if (containsPin(v, depth + 1)) return true;
      }
      return false;
    };
    expect(containsPin(session, 0)).toBe(false);
  });
});
