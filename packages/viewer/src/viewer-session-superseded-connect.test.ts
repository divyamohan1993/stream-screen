import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, SignalMessage } from '@stream-screen/core';

/**
 * Regression for FINDING P2 (viewer-session.ts — superseded connect must not emit
 * a late 'error').
 *
 * If the user retries or picks another host while a previous connect() is still
 * awaiting the socket/join, App disconnects that old session. The rejected async
 * path of the OLD session must NOT reach setState('error', …): App's GLOBAL state
 * handler updates state without (at this layer) distinguishing sessions, so a
 * stale failure from the CANCELED attempt could otherwise overwrite a newer
 * connecting/connected session and bounce the UI back to 'error'.
 *
 * Fix (layer 1, in ViewerSession): once the session is disconnected/closed,
 * setState is a NO-OP, so a superseded/torn-down session can never emit a late
 * 'error' or any other state change.
 *
 * We mock core's Peer/SignalingClient so we can make connect() hang awaiting the
 * socket connect, disconnect() it mid-flight, then let the awaited path REJECT and
 * assert NO 'error' (and no other state) is emitted after the disconnect.
 */

type StateCb = (s: RTCPeerConnectionState) => void;

class FakePeer {
  static instances: FakePeer[] = [];
  static current: FakePeer | null = null;
  stateCb: StateCb | null = null;
  closed = false;

  constructor() {
    FakePeer.instances.push(this);
    FakePeer.current = this;
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'state') this.stateCb = cb as StateCb;
  }
  async start(): Promise<void> {}
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
 * Signaling fake whose connect() promise is held open until the test releases it,
 * so we can disconnect the session WHILE connect() is still awaiting the socket.
 */
class FakeSignaling {
  static instances: FakeSignaling[] = [];
  closed = false;
  private rejectConnectFn: ((e: Error) => void) | null = null;
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
  connect(): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      this.rejectConnectFn = reject;
    });
  }
  /** Reject the pending connect() (simulate the awaited socket failing). */
  failConnect(msg: string): void {
    this.rejectConnectFn?.(new Error(msg));
  }
  join(): void {
    this.handlers.get('joined')?.({ type: 'joined' } as SignalMessage);
  }
  close(): void {
    this.closed = true;
  }
}

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: FakeSignaling };
});

const { ViewerSession } = await import('./viewer-session.js');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;

describe('ViewerSession superseded connect (FINDING P2)', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    FakePeer.current = null;
    FakeSignaling.instances = [];
  });

  it('a connect() disconnected while awaiting does NOT emit a late error', async () => {
    const states: string[] = [];
    const handlers: Handlers = { onState: (s) => states.push(s) };
    const session = new ViewerSession({
      code: '123456',
      signalingUrl: 'ws://x:8787',
      handlers,
    });

    // connect() begins and hangs awaiting the signaling socket connect().
    const p = session.connect();
    await Promise.resolve();
    expect(states).toContain('connecting');
    const sig = FakeSignaling.instances[0]!;

    // The user retried / picked another host: App disconnects the old session
    // while connect() is still awaiting the socket. disconnect() emits the
    // intentional terminal 'disconnected' and marks the session closed.
    session.disconnect();
    expect(states).toContain('disconnected');
    const statesAtDisconnect = states.length;

    // NOW the awaited socket connect rejects — the OLD, superseded session's
    // rejected async path runs its catch.
    sig.failConnect('socket gone');
    await expect(p).rejects.toThrow(/socket gone/);

    // No late 'error' (nor any other state) was emitted after the disconnect.
    expect(states).not.toContain('error');
    expect(states.length).toBe(statesAtDisconnect);
    expect(session.currentState).toBe('disconnected');
  });

  it('a still-live connect() that fails DOES emit error (guard does not suppress real failures)', async () => {
    const states: string[] = [];
    const handlers: Handlers = { onState: (s) => states.push(s) };
    const session = new ViewerSession({
      code: '123456',
      signalingUrl: 'ws://x:8787',
      handlers,
    });

    const p = session.connect();
    await Promise.resolve();
    const sig = FakeSignaling.instances[0]!;

    // No external disconnect this time — the live session's socket simply fails.
    sig.failConnect('boom');
    await expect(p).rejects.toThrow(/boom/);

    // The real connect failure is still surfaced as 'error'.
    expect(states).toContain('error');
    expect(session.currentState).toBe('error');
  });
});
