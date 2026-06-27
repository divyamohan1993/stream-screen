/**
 * Regression tests for the connect() join handshake (P2, session.ts).
 *
 * Before the fix, connect() sent `join` to the signaling server and then set
 * `connectedCode` immediately — without waiting for the server's `joined`
 * acknowledgement. So connecting with a syntactically valid but NONEXISTENT
 * code (server replies `error:no-such-session`) reported a successful connect,
 * and subsequent control calls silently targeted an unjoined socket.
 *
 * These tests prove connect() now WAITS for the acknowledgement:
 *  - an `error` reply (no-such-session) REJECTS and leaves the session
 *    disconnected (connectedCode stays null);
 *  - a `joined` reply RESOLVES and sets connectedCode;
 *  - a missing reply REJECTS via the handshake timeout (not a session limit).
 *
 * The signaling client is fully mocked (no WebSocket); a fake RTCPeerConnection
 * ctor is injected so no native WebRTC runtime is required.
 */

import { describe, expect, it } from 'vitest';
import { RemoteDesktopSession, JoinRejectedError } from '../src/session.js';
import type { SessionSignaling } from '../src/session.js';

/** Minimal inert RTCPeerConnection so Peer construction/start never touches a real runtime. */
class FakeRTCPeerConnection {
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  onnegotiationneeded: unknown = null;
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

type AckHandler = (m: { type: string; message?: string }) => void;

/**
 * A fake SignalingClient that records join() and lets the test fire the server's
 * acknowledgement. By default it fires nothing (so the test drives the reply).
 */
class FakeSignaling implements SessionSignaling {
  joined: Array<{ code?: string; role: string }> = [];
  closed = false;
  private handlers = new Map<string, Set<AckHandler>>();
  /** When set, automatically fire this acknowledgement on the next join(). */
  autoReply: { type: 'joined' | 'error'; message?: string } | null = null;

  async connect(): Promise<void> {}

  join(p: { code?: string; role: string }): void {
    this.joined.push({ code: p.code, role: p.role });
    if (this.autoReply) {
      const reply = this.autoReply;
      queueMicrotask(() => this.fire(reply.type, { type: reply.type, message: reply.message }));
    }
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

  close(): void {
    this.closed = true;
  }

  /** Test helper: deliver an inbound signaling message to subscribers. */
  fire(type: string, m: { type: string; message?: string }): void {
    for (const cb of this.handlers.get(type) ?? []) cb(m);
  }

  /**
   * Number of handshake (`joined`/`error`) listeners still registered. connect()
   * must remove both after the handshake settles. (The Peer separately registers
   * peer-joined/offer/answer/ice listeners, which are unrelated to the handshake.)
   */
  get handshakeListenerCount(): number {
    return (this.handlers.get('joined')?.size ?? 0) + (this.handlers.get('error')?.size ?? 0);
  }
}

function makeSession(signaling: FakeSignaling, joinTimeoutMs?: number): RemoteDesktopSession {
  return new RemoteDesktopSession({
    signalingUrl: 'ws://127.0.0.1:8787',
    rtcPeerConnection: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    signalingClientFactory: () => signaling,
    ...(joinTimeoutMs !== undefined ? { joinTimeoutMs } : {}),
  });
}

describe('RemoteDesktopSession.connect — join acknowledgement handshake (P2)', () => {
  it('REJECTS and does NOT set connectedCode when the server replies error:no-such-session', async () => {
    const signaling = new FakeSignaling();
    signaling.autoReply = { type: 'error', message: 'no-such-session' };
    const session = makeSession(signaling);

    await expect(session.connect('999888')).rejects.toMatchObject({
      name: 'JoinRejectedError',
      message: 'no-such-session',
    });

    // The bug: connect() used to resolve and set connectedCode here.
    expect(session.connected).toBe(false);
    expect(session.code).toBeNull();
    // The join was actually sent, and the half-open client was torn down.
    expect(signaling.joined).toEqual([{ code: '999888', role: 'viewer' }]);
    expect(signaling.closed).toBe(true);
    expect(signaling.handshakeListenerCount).toBe(0);
  });

  it('RESOLVES and sets connectedCode when the server replies joined', async () => {
    const signaling = new FakeSignaling();
    signaling.autoReply = { type: 'joined' };
    const session = makeSession(signaling);

    await expect(session.connect('123456')).resolves.toBeUndefined();

    expect(session.connected).toBe(true);
    expect(session.code).toBe('123456');
    expect(signaling.joined).toEqual([{ code: '123456', role: 'viewer' }]);
    // A successful connect keeps the socket open and removes its handshake listeners.
    expect(signaling.closed).toBe(false);
    expect(signaling.handshakeListenerCount).toBe(0);
  });

  it('REJECTS (connect handshake timeout) when the server never acknowledges — not a session limit', async () => {
    const signaling = new FakeSignaling(); // no autoReply: never answers
    const session = makeSession(signaling, 20);

    await expect(session.connect('123456')).rejects.toBeInstanceOf(JoinRejectedError);
    expect(session.connected).toBe(false);
    expect(session.code).toBeNull();
    expect(signaling.closed).toBe(true);
  });
});
