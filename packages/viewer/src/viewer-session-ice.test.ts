import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, SignalMessage } from '@stream-screen/core';

/**
 * "Connect from anywhere" ICE wiring for the viewer.
 *
 * The signaling server distributes a STUN/TURN list on the `joined` ack so BOTH
 * peers negotiate against the SAME config. The viewer must build its {@link
 * Peer} with that server-distributed list — UNLESS a local override was supplied
 * (which wins), and falling back to NONE (LAN-only) when neither is present.
 *
 * We mock core's Peer/SignalingClient: FakePeer records the `iceServers` it was
 * constructed with, and FakeSignaling can attach an `iceServers` field to its
 * `joined` ack so we can assert what the session built the peer with.
 */

type StateCb = (s: RTCPeerConnectionState) => void;

class FakePeer {
  static instances: FakePeer[] = [];
  static current: FakePeer | null = null;
  readonly iceServers: RTCIceServer[];
  stateCb: StateCb | null = null;
  started = false;
  closed = false;

  constructor(opts: { iceServers?: RTCIceServer[] }) {
    // Capture EXACTLY what the session passed so tests can assert the negotiated
    // config (server-distributed vs. local override vs. none).
    this.iceServers = opts.iceServers ?? [];
    FakePeer.instances.push(this);
    FakePeer.current = this;
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'state') this.stateCb = cb as StateCb;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  onControl(_cb: (m: ControlMessage) => void): void {}
  onFileChunk(_cb: (b: ArrayBuffer) => void): void {}
  onInput(_cb: (e: InputEvent) => void): void {}
  sendControl(): void {}
  async getStats(): Promise<unknown> {
    return { rttMs: 0, fps: 0 };
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * Signaling fake whose `joined` ack can carry an `iceServers` field (the
 * server-distributed list). `ackIce` is attached to the `joined` message.
 */
class FakeSignaling {
  static instances: FakeSignaling[] = [];
  joins = 0;
  closed = false;
  /** When set, the `joined` ack carries this `iceServers` field. */
  ackIce: unknown = undefined;
  private handlers = new Map<string, (m: SignalMessage) => void>();

  constructor() {
    FakeSignaling.instances.push(this);
  }
  on(ev: string, cb: (m: SignalMessage) => void): void {
    this.handlers.set(ev, cb);
  }
  off(ev: string, _cb: (m: SignalMessage) => void): void {
    this.handlers.delete(ev);
  }
  async connect(): Promise<void> {}
  join(): void {
    this.joins++;
    const msg: Record<string, unknown> = { type: 'joined' };
    if (this.ackIce !== undefined) msg.iceServers = this.ackIce;
    this.handlers.get('joined')?.(msg as unknown as SignalMessage);
  }
  close(): void {
    this.closed = true;
  }
}

let armNext: ((s: FakeSignaling) => void) | null = null;
const SignalingProxy = class extends FakeSignaling {
  constructor() {
    super();
    armNext?.(this);
    armNext = null;
  }
};

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: SignalingProxy };
});

const { ViewerSession } = await import('./viewer-session.js');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;
type Options = import('./viewer-session.js').ViewerSessionOptions;

async function connect(over: Partial<Options> = {}) {
  const handlers: Handlers = {};
  const session = new ViewerSession({
    code: '123456',
    signalingUrl: 'ws://x:8787',
    handlers,
    ...over,
  });
  await session.connect();
  return session;
}

describe('ViewerSession ICE config (connect from anywhere)', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    FakePeer.current = null;
    FakeSignaling.instances = [];
    armNext = null;
  });

  it('builds the Peer with the server-distributed iceServers from the joined ack', async () => {
    const serverIce: RTCIceServer[] = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ];
    armNext = (s) => (s.ackIce = serverIce);
    const session = await connect();

    const peer = FakePeer.current!;
    expect(peer.iceServers).toEqual(serverIce);
    expect(session.effectiveIceServers).toEqual(serverIce);
  });

  it('a local override takes precedence over the server-distributed list', async () => {
    const serverIce: RTCIceServer[] = [{ urls: 'stun:server-distributed.example:3478' }];
    const localIce: RTCIceServer[] = [
      { urls: 'turn:my-turn.example:3478', username: 'me', credential: 'secret' },
    ];
    armNext = (s) => (s.ackIce = serverIce);
    const session = await connect({ iceServers: localIce });

    const peer = FakePeer.current!;
    expect(peer.iceServers).toEqual(localIce);
    expect(session.effectiveIceServers).toEqual(localIce);
  });

  it('no override and no server list => LAN-only (empty iceServers)', async () => {
    const session = await connect();
    const peer = FakePeer.current!;
    expect(peer.iceServers).toEqual([]);
    expect(session.effectiveIceServers).toEqual([]);
  });

  it('an empty server-distributed list keeps LAN-only behavior', async () => {
    armNext = (s) => (s.ackIce = []);
    const session = await connect();
    expect(FakePeer.current!.iceServers).toEqual([]);
    expect(session.effectiveIceServers).toEqual([]);
  });

  it('a malformed iceServers field on the ack is ignored (LAN-only)', async () => {
    // Not an RTCIceServer[] — must be rejected by the isIceServerList guard and
    // never reach the Peer; behavior stays LAN-only.
    armNext = (s) => (s.ackIce = 'stun:not-an-array:3478');
    const session = await connect();
    expect(FakePeer.current!.iceServers).toEqual([]);
    expect(session.effectiveIceServers).toEqual([]);
  });

  it('effectiveIceServers returns a defensive copy (callers cannot mutate state)', async () => {
    const serverIce: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];
    armNext = (s) => (s.ackIce = serverIce);
    const session = await connect();
    const first = session.effectiveIceServers;
    first.push({ urls: 'turn:evil.example:3478' });
    (first[0] as RTCIceServer).urls = 'stun:tampered';
    // A fresh read is unaffected by mutating a previous result.
    expect(session.effectiveIceServers).toEqual(serverIce);
  });
});
