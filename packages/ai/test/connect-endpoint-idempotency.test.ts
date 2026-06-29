/**
 * Regression tests for connect() idempotency keying on the ENDPOINT (P2, session.ts).
 *
 * Before the fix, connect() short-circuited whenever the CODE matched the live
 * session, ignoring the signaling endpoint. In multi-host/multi-server setups a
 * numeric code is not globally unique (code collisions across servers, or an
 * explicit endpoint override), so `connect(code, urlA)` followed by
 * `connect(code, urlB)` returned early WITHOUT switching: subsequent
 * screenshots/inputs still targeted urlA while the tool reported the urlB
 * connect as successful.
 *
 * These tests prove connect() now keys idempotency on BOTH the code AND the
 * resolved endpoint:
 *  - connect(code, urlA) then connect(code, urlB) DISCONNECTS the urlA client
 *    and reconnects against a fresh client built with urlB;
 *  - connect(code, sameUrl) while already connected stays a no-op (idempotent):
 *    no disconnect, no new client.
 *
 * The signaling client is fully mocked (no WebSocket); a fake RTCPeerConnection
 * ctor is injected so no native WebRTC runtime is required.
 */

import { describe, expect, it } from 'vitest';
import { RemoteDesktopSession } from '../src/session.js';
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
 * A fake SignalingClient that immediately auto-acknowledges every join() with
 * `joined`, and records the URL it was constructed with so a test can assert
 * which endpoint connect() resolved.
 */
class FakeSignaling implements SessionSignaling {
  closed = false;
  joined: Array<{ code?: string; role: string }> = [];
  private handlers = new Map<string, Set<AckHandler>>();

  constructor(readonly url: string) {}

  async connect(): Promise<void> {}

  join(p: { code?: string; role: string }): void {
    this.joined.push({ code: p.code, role: p.role });
    queueMicrotask(() => this.fire('joined', { type: 'joined' }));
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

  fire(type: string, m: { type: string; message?: string }): void {
    for (const cb of this.handlers.get(type) ?? []) cb(m);
  }
}

/**
 * Build a session whose signaling factory records every client it creates,
 * tagged with the URL connect() resolved. Lets a test assert the endpoint
 * switch (a new client built with the new URL) versus the idempotent no-op.
 */
function makeSession(): { session: RemoteDesktopSession; built: FakeSignaling[] } {
  const built: FakeSignaling[] = [];
  const session = new RemoteDesktopSession({
    signalingUrl: 'ws://default:8787',
    rtcPeerConnection: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    signalingClientFactory: (url: string) => {
      const s = new FakeSignaling(url);
      built.push(s);
      return s;
    },
  });
  return { session, built };
}

describe('RemoteDesktopSession.connect — endpoint-aware idempotency (P2)', () => {
  it('DISCONNECTS the old client and reconnects with a fresh client at the new endpoint when the same code is connected to a DIFFERENT endpoint', async () => {
    const urlA = 'ws://host-a:8787';
    const urlB = 'ws://host-b:8787';
    const { session, built } = makeSession();

    await session.connect('123456', urlA);
    expect(session.connected).toBe(true);
    expect(session.code).toBe('123456');
    expect(built).toHaveLength(1);
    expect(built[0].url).toBe(urlA);
    expect(built[0].closed).toBe(false);

    // Same code, DIFFERENT endpoint: must switch hosts, not short-circuit.
    await session.connect('123456', urlB);

    expect(session.connected).toBe(true);
    expect(session.code).toBe('123456');
    // The urlA client was torn down...
    expect(built[0].closed).toBe(true);
    // ...and a brand-new client was built against urlB and joined there.
    expect(built).toHaveLength(2);
    expect(built[1].url).toBe(urlB);
    expect(built[1].closed).toBe(false);
    expect(built[1].joined).toEqual([{ code: '123456', role: 'viewer' }]);
  });

  it('is a NO-OP (idempotent) when reconnecting to the same code at the SAME endpoint', async () => {
    const urlA = 'ws://host-a:8787';
    const { session, built } = makeSession();

    await session.connect('123456', urlA);
    expect(built).toHaveLength(1);

    // Same code, same endpoint: short-circuit — no disconnect, no new client.
    await session.connect('123456', urlA);

    expect(session.connected).toBe(true);
    expect(session.code).toBe('123456');
    expect(built).toHaveLength(1);
    expect(built[0].closed).toBe(false);
    // Only the original join was sent; the no-op did not re-join.
    expect(built[0].joined).toEqual([{ code: '123456', role: 'viewer' }]);
  });
});
