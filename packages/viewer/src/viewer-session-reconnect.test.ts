import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ControlMessage, InputEvent } from '@stream-screen/core';

/**
 * Reconnection tests for the viewer session.
 *
 * A transient WebRTC path drop must NOT kill the session. We mock core's
 * `Peer`/`SignalingClient` so we can drive synthetic connection-state
 * transitions and observe that the session:
 *   - shows `reconnecting` (not a terminal state) on `disconnected`,
 *   - self-heals back to `connected` if the blip recovers inside the grace window,
 *   - rebuilds the peer (new Peer + start + re-join) when the grace timer fires,
 *   - rebuilds immediately on a hard `failed`.
 */

type StateCb = (s: RTCPeerConnectionState) => void;

class FakePeer {
  static instances: FakePeer[] = [];
  static current: FakePeer | null = null;
  stateCb: StateCb | null = null;
  started = false;
  closed = false;

  constructor() {
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
  close(): void {
    this.closed = true;
  }
  /** Drive a synthetic peer connection-state change. */
  emitState(s: RTCPeerConnectionState): void {
    this.stateCb?.(s);
  }
}

class FakeSignaling {
  joins = 0;
  connects = 0;
  closed = false;
  on(): void {}
  async connect(): Promise<void> {
    this.connects++;
  }
  join(): void {
    this.joins++;
  }
  close(): void {
    this.closed = true;
  }
}

/** Every SignalingClient ever constructed, in order. */
let signalingInstances: FakeSignaling[] = [];
let lastSignaling: FakeSignaling | null = null;
const SignalingProxy = class extends FakeSignaling {
  constructor() {
    super();
    signalingInstances.push(this);
    lastSignaling = this;
  }
};

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: SignalingProxy };
});

const { ViewerSession } = await import('./viewer-session.js');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;

async function connected(over: Partial<import('./viewer-session.js').ViewerSessionOptions> = {}) {
  const states: string[] = [];
  const handlers: Handlers = { onState: (s) => states.push(s) };
  const session = new ViewerSession({
    code: '123456',
    signalingUrl: 'ws://x:8787',
    handlers,
    ...over,
  });
  await session.connect();
  FakePeer.current!.emitState('connected');
  return { session, states };
}

describe('ViewerSession reconnection', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    FakePeer.current = null;
    signalingInstances = [];
    lastSignaling = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces reconnecting (not error/disconnected) on a transient drop', async () => {
    const { session, states } = await connected();
    FakePeer.current!.emitState('disconnected');
    expect(session.currentState).toBe('reconnecting');
    expect(states).not.toContain('error');
  });

  it('self-heals back to connected within the grace window without rebuilding', async () => {
    const { session } = await connected({ reconnectGraceMs: 5000 });
    const peer = FakePeer.current!;
    peer.emitState('disconnected');
    // Recover before the grace timer fires.
    vi.advanceTimersByTime(1000);
    peer.emitState('connected');
    vi.advanceTimersByTime(10000);
    expect(session.currentState).toBe('connected');
    // Same peer kept; no rebuild.
    expect(FakePeer.instances).toHaveLength(1);
    expect(peer.closed).toBe(false);
  });

  it('rebuilds the peer when the grace timer expires', async () => {
    const { session } = await connected({ reconnectGraceMs: 3000 });
    const first = FakePeer.current!;
    first.emitState('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    // Old peer closed, a fresh peer built + started, and we re-joined the room
    // on a fresh signaling socket.
    expect(first.closed).toBe(true);
    expect(FakePeer.instances).toHaveLength(2);
    expect(FakePeer.current!.started).toBe(true);
    expect(lastSignaling!.joins).toBe(1);
    expect(session.currentState).toBe('reconnecting');
  });

  it('closes+reopens the signaling socket on rebuild (not a re-join on the same socket)', async () => {
    // Regression for CODEX P2: re-joining the SAME already-joined socket is
    // rejected by the server as `already-joined`, so the host never re-offers to
    // the rebuilt peer. The reconnect path must CLOSE the old SignalingClient and
    // open a fresh one, then join on that, so the host sees peer-left then a fresh
    // peer-joined and re-offers.
    await connected({ reconnectGraceMs: 3000 });
    const firstSignaling = signalingInstances[0]!;
    expect(signalingInstances).toHaveLength(1);
    expect(firstSignaling.joins).toBe(1);
    expect(firstSignaling.closed).toBe(false);

    FakePeer.current!.emitState('disconnected');
    await vi.advanceTimersByTimeAsync(3000);

    // The original socket was closed, NOT re-joined a second time.
    expect(firstSignaling.closed).toBe(true);
    expect(firstSignaling.joins).toBe(1);
    // A brand-new SignalingClient was constructed, (re)connected, and joined once.
    expect(signalingInstances).toHaveLength(2);
    const secondSignaling = signalingInstances[1]!;
    expect(secondSignaling).not.toBe(firstSignaling);
    expect(secondSignaling.connects).toBe(1);
    expect(secondSignaling.joins).toBe(1);
    expect(secondSignaling.closed).toBe(false);
  });

  it('rebuilds immediately on a hard failed state', async () => {
    await connected();
    const first = FakePeer.current!;
    first.emitState('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true);
    expect(FakePeer.instances).toHaveLength(2);
    expect(FakePeer.current!.started).toBe(true);
  });

  it('a recovered rebuilt peer reaches connected', async () => {
    const { session } = await connected();
    FakePeer.current!.emitState('failed');
    await vi.advanceTimersByTimeAsync(0);
    FakePeer.current!.emitState('connected');
    expect(session.currentState).toBe('connected');
  });

  it('disconnect() cancels a pending reconnect and does not rebuild', async () => {
    const { session } = await connected({ reconnectGraceMs: 3000 });
    FakePeer.current!.emitState('disconnected');
    session.disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.currentState).toBe('disconnected');
    // No new peer was stood up after disconnect.
    expect(FakePeer.instances).toHaveLength(1);
  });
});
