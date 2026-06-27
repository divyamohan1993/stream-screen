import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, SignalMessage } from '@stream-screen/core';

/**
 * Regression for FINDING P2 (viewer join-ack lifecycle).
 *
 * A syntactically valid but NONEXISTENT/FULL code yields a signaling `error`
 * (e.g. `no-such-session`) while the socket stays unjoined. The viewer must NOT
 * resolve connect(), enter `waiting-for-host`, or start the stats loop on such a
 * code. It must AWAIT the `joined` acknowledgement, and on `error` (or a
 * connect-time join-ack timeout) REJECT connect() and fully tear down — CLOSING
 * the SignalingClient so its remembered `lastJoin` is never reconnected/replayed
 * and stopping any loop.
 *
 * We mock core's Peer/SignalingClient so we can choose whether `join()` is
 * acknowledged with `joined` or rejected with `error`, and observe the teardown.
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
}

/**
 * A signaling fake whose `join()` reply is configurable: by default it
 * acknowledges with `joined`; set `rejectWith` to instead reply `error`, or set
 * `silent` to never reply (to exercise the handshake timeout).
 */
class FakeSignaling {
  static instances: FakeSignaling[] = [];
  joins = 0;
  connects = 0;
  closed = false;
  /** When set, join() replies `error` with this message instead of `joined`. */
  rejectWith: string | null = null;
  /** When true, join() never replies (exercise the join-ack timeout). */
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

/**
 * Lets a test pre-arm the NEXT SignalingClient to be constructed (so we can make
 * the very first one reject/timeout before connect() builds it).
 */
let armNext: ((s: FakeSignaling) => void) | null = null;
const SignalingProxy = class extends FakeSignaling {
  constructor() {
    super();
    armNext?.(this);
  }
};

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: SignalingProxy };
});

const { ViewerSession } = await import('./viewer-session.js');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;

function makeSession(over: Partial<import('./viewer-session.js').ViewerSessionOptions> = {}) {
  const states: string[] = [];
  const handlers: Handlers = { onState: (s) => states.push(s) };
  const session = new ViewerSession({
    code: '123456',
    signalingUrl: 'ws://x:8787',
    handlers,
    ...over,
  });
  return { session, states };
}

describe('ViewerSession join-ack lifecycle (FINDING P2)', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    FakePeer.current = null;
    FakeSignaling.instances = [];
    armNext = null;
  });

  it('connect() to a code yielding a signaling error REJECTS and does not enter waiting/start stats', async () => {
    armNext = (s) => (s.rejectWith = 'no-such-session');
    const { session, states } = makeSession();

    await expect(session.connect()).rejects.toThrow(/no-such-session/);

    // Never entered the joined lifecycle.
    expect(states).not.toContain('waiting-for-host');
    expect(session.currentState).toBe('error');
  });

  it('a rejected join CLOSES the signaling client so its lastJoin is not reconnected/replayed', async () => {
    armNext = (s) => (s.rejectWith = 'no-such-session');
    const { session } = makeSession();
    await expect(session.connect()).rejects.toThrow();

    expect(FakeSignaling.instances).toHaveLength(1);
    const sig = FakeSignaling.instances[0]!;
    // The single join that was attempted, and the socket fully closed so the
    // SignalingClient's reconnect/replay path can never fire.
    expect(sig.joins).toBe(1);
    expect(sig.closed).toBe(true);
    expect(FakePeer.current?.closed).toBe(true);
  });

  it('a rejected join never starts the stats loop (no stats polled even after time passes)', async () => {
    vi.useFakeTimers();
    try {
      armNext = (s) => (s.rejectWith = 'no-such-session');
      const { session } = makeSession({ statsIntervalMs: 100 });
      await expect(session.connect()).rejects.toThrow();
      const peer = FakePeer.instances[0]!;
      await vi.advanceTimersByTimeAsync(1000);
      // The stats loop was never armed, so getStats was never polled.
      expect(peer.statsCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a connect-time join-ack TIMEOUT rejects and tears down', async () => {
    vi.useFakeTimers();
    try {
      armNext = (s) => (s.silent = true);
      const { session } = makeSession({ joinTimeoutMs: 2000 });
      const p = session.connect();
      const assertion = expect(p).rejects.toThrow(/Timed out/);
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(session.currentState).toBe('error');
      const sig = FakeSignaling.instances[0]!;
      expect(sig.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connect() that yields joined resolves and starts normally (waiting-for-host + stats loop)', async () => {
    vi.useFakeTimers();
    try {
      const { session, states } = makeSession({ statsIntervalMs: 100 });
      await session.connect();
      expect(session.currentState).toBe('waiting-for-host');
      expect(states).toContain('waiting-for-host');
      const sig = FakeSignaling.instances[0]!;
      expect(sig.joins).toBe(1);
      expect(sig.closed).toBe(false);
      // The stats loop is running: getStats is polled on the interval.
      const peer = FakePeer.current!;
      await vi.advanceTimersByTimeAsync(250);
      expect(peer.statsCalls).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
