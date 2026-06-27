import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ControlMessage, InputEvent, SignalMessage } from '@stream-screen/core';

/**
 * Regression for FINDING P2 (viewer-session.ts:475 — "Tear down failed ICE
 * rebuilds").
 *
 * When an ICE failure triggers a peer rebuild and that rebuild's FRESH join is
 * rejected or times out (e.g. the host left during the reconnect grace period),
 * the catch must FULLY tear down: close the freshly-created peer AND signaling
 * (so the SignalingClient's remembered `lastJoin` is never reconnected/replayed
 * while the UI is already in 'error') and stop the stats loop, leaving the
 * session cleanly in 'error'. Previously the catch only set state to 'error'
 * and left the fresh peer/signaling alive and the stats loop running.
 *
 * We mock core's Peer/SignalingClient so we can: (1) ack the FIRST join so the
 * initial connect succeeds and the stats loop starts, then (2) arm the SECOND
 * (rebuild) SignalingClient to reject `error` (or stay silent → timeout), drive
 * an ICE `failed`, and observe the teardown.
 */

type StateCb = (s: RTCPeerConnectionState) => void;

class FakePeer {
  static instances: FakePeer[] = [];
  static current: FakePeer | null = null;
  stateCb: StateCb | null = null;
  started = false;
  closed = false;
  statsCalls = 0;

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
  async getStats(): Promise<unknown> {
    this.statsCalls++;
    return { rttMs: 0, fps: 0 };
  }
  close(): void {
    this.closed = true;
  }
  emitState(s: RTCPeerConnectionState): void {
    this.stateCb?.(s);
  }
}

/**
 * Signaling fake whose `join()` reply is configurable per-instance: by default
 * it acks with `joined`; set `rejectWith` to reply `error`, or `silent` to never
 * reply (exercise the join-ack timeout).
 */
class FakeSignaling {
  static instances: FakeSignaling[] = [];
  joins = 0;
  connects = 0;
  closed = false;
  rejectWith: string | null = null;
  silent = false;
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
  async connect(): Promise<void> {
    this.connects++;
  }
  join(): void {
    this.joins++;
    if (this.silent) return;
    if (this.rejectWith !== null) {
      this.handlers.get('error')?.({ type: 'error', message: this.rejectWith } as SignalMessage);
      return;
    }
    this.handlers.get('joined')?.({ type: 'joined' } as SignalMessage);
  }
  close(): void {
    this.closed = true;
  }
}

/** Lets a test pre-arm the NEXT SignalingClient to be constructed. */
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

async function connected(over: Partial<Options> = {}) {
  const states: string[] = [];
  const handlers: Handlers = { onState: (s) => states.push(s) };
  const session = new ViewerSession({
    code: '123456',
    signalingUrl: 'ws://x:8787',
    handlers,
    ...over,
  });
  // First SignalingClient acks `joined` by default → connect() resolves and the
  // stats loop starts.
  await session.connect();
  FakePeer.current!.emitState('connected');
  return { session, states };
}

describe('ViewerSession ICE-rebuild failure teardown (FINDING P2 viewer-session.ts:475)', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    FakePeer.current = null;
    FakeSignaling.instances = [];
    armNext = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tears down the fresh peer + signaling and stops stats when the rebuild join is REJECTED', async () => {
    const { session } = await connected({ statsIntervalMs: 100 });
    expect(FakeSignaling.instances).toHaveLength(1);
    expect(FakePeer.instances).toHaveLength(1);

    // Arm the rebuild's fresh SignalingClient to reject (host left during grace).
    armNext = (s) => (s.rejectWith = 'no-such-session');

    // Hard ICE failure → immediate rebuild.
    FakePeer.current!.emitState('failed');
    await vi.advanceTimersByTimeAsync(0);

    // A fresh peer + signaling were created for the rebuild...
    expect(FakePeer.instances).toHaveLength(2);
    expect(FakeSignaling.instances).toHaveLength(2);
    const freshPeer = FakePeer.instances[1]!;
    const freshSignaling = FakeSignaling.instances[1]!;

    // ...and BOTH are fully closed on the rejection (so the SignalingClient's
    // lastJoin can never be reconnected/replayed).
    expect(freshPeer.closed).toBe(true);
    expect(freshSignaling.closed).toBe(true);
    expect(freshSignaling.joins).toBe(1);

    // Session is cleanly in 'error'.
    expect(session.currentState).toBe('error');
  });

  it('stops the stats loop after a rejected rebuild (no further poll calls)', async () => {
    await connected({ statsIntervalMs: 100 });
    const freshPeerCountBefore = FakePeer.instances.length;

    armNext = (s) => (s.rejectWith = 'no-such-session');
    FakePeer.current!.emitState('failed');
    await vi.advanceTimersByTimeAsync(0);

    const freshPeer = FakePeer.instances[freshPeerCountBefore]!;
    const pollsAfterTeardown = freshPeer.statsCalls;
    // Advance well past several stats intervals: the loop must be stopped, so no
    // additional polls happen on either the fresh peer or the (nulled) old one.
    await vi.advanceTimersByTimeAsync(1000);
    expect(freshPeer.statsCalls).toBe(pollsAfterTeardown);
    for (const p of FakePeer.instances) expect(p.statsCalls).toBe(0);
  });

  it('does NOT replay/reconnect a join after a rejected rebuild', async () => {
    const { session } = await connected({ statsIntervalMs: 100 });

    armNext = (s) => (s.rejectWith = 'no-such-session');
    FakePeer.current!.emitState('failed');
    await vi.advanceTimersByTimeAsync(0);

    const freshSignaling = FakeSignaling.instances[1]!;
    // Let plenty of time pass — nothing should re-join or build another peer.
    await vi.advanceTimersByTimeAsync(20000);
    expect(freshSignaling.joins).toBe(1);
    expect(FakeSignaling.instances).toHaveLength(2);
    expect(FakePeer.instances).toHaveLength(2);
    expect(session.currentState).toBe('error');
  });

  it('tears down the same way when the rebuild join TIMES OUT', async () => {
    const { session } = await connected({ statsIntervalMs: 100, joinTimeoutMs: 2000 });

    // Arm the rebuild's fresh socket to never reply → join-ack timeout.
    armNext = (s) => (s.silent = true);
    FakePeer.current!.emitState('failed');
    // Drive the rebuild far enough to create the fresh peer/signaling and arm
    // the join-ack timer, then fire the timeout.
    await vi.advanceTimersByTimeAsync(2000);

    const freshPeer = FakePeer.instances[1]!;
    const freshSignaling = FakeSignaling.instances[1]!;
    expect(freshPeer.closed).toBe(true);
    expect(freshSignaling.closed).toBe(true);
    expect(session.currentState).toBe('error');

    // And no replay afterwards.
    await vi.advanceTimersByTimeAsync(20000);
    expect(freshSignaling.joins).toBe(1);
    expect(FakePeer.instances).toHaveLength(2);
  });

  it('a SUCCESSFUL rebuild still reaches connected (teardown only on failure)', async () => {
    const { session } = await connected({ statsIntervalMs: 100 });
    // Default: the fresh signaling acks `joined`, so the rebuild succeeds.
    FakePeer.current!.emitState('failed');
    await vi.advanceTimersByTimeAsync(0);
    const freshPeer = FakePeer.instances[1]!;
    expect(freshPeer.closed).toBe(false);
    freshPeer.emitState('connected');
    expect(session.currentState).toBe('connected');
  });
});
