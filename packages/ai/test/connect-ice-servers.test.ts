/**
 * Regression tests for P2-3 (session.ts): the AI client must negotiate against
 * the SAME ICE config the signaling server distributes on the `joined` ack.
 *
 * Before the fix, connect() built the viewer Peer with only `opts.iceServers`
 * and ignored the server-distributed STUN/TURN list carried on the `joined`
 * acknowledgement. So an AI session relying on server-distributed STUN/TURN
 * never received those servers and failed to traverse beyond the LAN.
 *
 * These tests prove the fix mirrors host/viewer precedence:
 *  - joined ack carries iceServers + no override -> Peer built with that list;
 *  - an explicit override (opts.iceServers / STREAMSCREEN_ICE_SERVERS) WINS over
 *    the joined list;
 *  - neither present -> [] (LAN-only, unchanged);
 *  - a malformed joined iceServers field is ignored (LAN-only).
 *
 * The Peer is intercepted via a fake RTCPeerConnection so its constructor's
 * configured `iceServers` (passed through to RTCPeerConnection.config) can be
 * asserted without a native WebRTC runtime or a real socket.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteDesktopSession } from '../src/session.js';
import type { SessionSignaling, SignalAck } from '../src/session.js';

type AckHandler = (m: SignalAck) => void;

/**
 * Records the `iceServers` it was constructed with so a test can assert what the
 * Peer/RTCPeerConnection negotiates against. `@stream-screen/core`'s Peer passes
 * its `iceServers` option straight into `new RTCPeerConnection({ iceServers })`.
 */
class RecordingRTCPeerConnection {
  static lastConfig: RTCConfiguration | undefined;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  onnegotiationneeded: unknown = null;
  constructor(config?: RTCConfiguration) {
    RecordingRTCPeerConnection.lastConfig = config;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  createDataChannel(): unknown {
    return { onopen: null, onmessage: null, onclose: null, send() {}, close() {} };
  }
  addTrack(): void {}
  getSenders(): unknown[] {
    return [];
  }
  close(): void {}
}

/** A fake SignalingClient that auto-fires a `joined` ack carrying iceServers. */
class FakeSignaling implements SessionSignaling {
  private handlers = new Map<string, Set<AckHandler>>();
  /** The iceServers field placed on the auto-fired `joined` ack. */
  joinedIceServers: unknown;

  async connect(): Promise<void> {}

  join(): void {
    queueMicrotask(() =>
      this.fire('joined', { type: 'joined', iceServers: this.joinedIceServers }),
    );
  }

  on(type: string, cb: AckHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb);
  }

  off(type: string, cb: AckHandler): void {
    this.handlers.get(type)?.delete(cb);
  }

  close(): void {}

  /**
   * Deliver an inbound signaling message to subscribers. The viewer Peer's
   * `peer-joined` handler stands up its RTCPeerConnection (with the configured
   * iceServers) on this event, so a test fires it to materialize the pc.
   */
  fire(type: string, m: Record<string, unknown>): void {
    for (const cb of this.handlers.get(type) ?? []) cb(m as unknown as SignalAck);
  }
}

function makeSession(
  signaling: FakeSignaling,
  opts: { iceServers?: RTCIceServer[] } = {},
): RemoteDesktopSession {
  return new RemoteDesktopSession({
    signalingUrl: 'ws://127.0.0.1:8787',
    rtcPeerConnection: RecordingRTCPeerConnection as unknown as typeof RTCPeerConnection,
    signalingClientFactory: () => signaling,
    ...(opts.iceServers ? { iceServers: opts.iceServers } : {}),
  });
}

/**
 * Connect, then fire `peer-joined` so the viewer Peer materializes its
 * RTCPeerConnection — capturing the iceServers it was constructed with into
 * {@link RecordingRTCPeerConnection.lastConfig}.
 */
async function connectAndMaterializePeer(
  session: RemoteDesktopSession,
  signaling: FakeSignaling,
): Promise<void> {
  await session.connect('123456');
  signaling.fire('peer-joined', { type: 'peer-joined', from: 'host-1' });
}

const SERVER_LIST: RTCIceServer[] = [
  { urls: 'stun:stun.example.com:3478' },
  { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
];
const OVERRIDE_LIST: RTCIceServer[] = [{ urls: 'stun:override.example.com:3478' }];

describe('RemoteDesktopSession.connect — server-distributed ICE servers (P2-3)', () => {
  const ENV = 'STREAMSCREEN_ICE_SERVERS';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV];
    delete process.env[ENV];
    RecordingRTCPeerConnection.lastConfig = undefined;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  it('builds the Peer with the joined-ack iceServers when no override is set', async () => {
    const signaling = new FakeSignaling();
    signaling.joinedIceServers = SERVER_LIST;
    const session = makeSession(signaling);

    await connectAndMaterializePeer(session, signaling);

    expect(session.effectiveIceServers).toEqual(SERVER_LIST);
    expect(RecordingRTCPeerConnection.lastConfig?.iceServers).toEqual(SERVER_LIST);
  });

  it('lets an explicit opts.iceServers override take precedence over the joined list', async () => {
    const signaling = new FakeSignaling();
    signaling.joinedIceServers = SERVER_LIST;
    const session = makeSession(signaling, { iceServers: OVERRIDE_LIST });

    await connectAndMaterializePeer(session, signaling);

    expect(session.effectiveIceServers).toEqual(OVERRIDE_LIST);
    expect(RecordingRTCPeerConnection.lastConfig?.iceServers).toEqual(OVERRIDE_LIST);
  });

  it('lets STREAMSCREEN_ICE_SERVERS override take precedence over the joined list', async () => {
    process.env[ENV] = 'stun:override.example.com:3478';
    const signaling = new FakeSignaling();
    signaling.joinedIceServers = SERVER_LIST;
    const session = makeSession(signaling);

    await connectAndMaterializePeer(session, signaling);

    expect(session.effectiveIceServers).toEqual([
      { urls: 'stun:override.example.com:3478' },
    ]);
    expect(RecordingRTCPeerConnection.lastConfig?.iceServers).toEqual([
      { urls: 'stun:override.example.com:3478' },
    ]);
  });

  it('defaults to [] (LAN-only) when neither a joined list nor an override is present', async () => {
    const signaling = new FakeSignaling(); // no iceServers on the ack
    const session = makeSession(signaling);

    await connectAndMaterializePeer(session, signaling);

    expect(session.effectiveIceServers).toEqual([]);
    expect(RecordingRTCPeerConnection.lastConfig?.iceServers).toEqual([]);
  });

  it('ignores a malformed joined iceServers field (LAN-only)', async () => {
    const signaling = new FakeSignaling();
    signaling.joinedIceServers = [{ urls: 42 }]; // not a valid RTCIceServer[]
    const session = makeSession(signaling);

    await connectAndMaterializePeer(session, signaling);

    expect(session.effectiveIceServers).toEqual([]);
    expect(RecordingRTCPeerConnection.lastConfig?.iceServers).toEqual([]);
  });
});
