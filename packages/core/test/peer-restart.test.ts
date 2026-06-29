import { describe, it, expect, vi } from 'vitest';
import { Peer } from '../src/peer.js';
import type { SignalMessage } from '../src/protocol.js';
import type { SignalingClient } from '../src/signaling-client.js';

/**
 * Tests for Peer.restartIce() / Peer.isOpen — the in-place ICE recovery path
 * used to survive transient transport drops without rebuilding the peer.
 */

type Handler = (m: SignalMessage) => void;

/** Minimal SignalingClient stand-in: records sends, lets tests fire events. */
class FakeSignaling {
  sent: SignalMessage[] = [];
  private readonly handlers = new Map<string, Handler[]>();
  on(type: string, cb: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  send(m: SignalMessage): void {
    this.sent.push(m);
  }
  fire(type: string, m: SignalMessage): void {
    for (const cb of this.handlers.get(type) ?? []) cb(m);
  }
}

/** Minimal RTCPeerConnection stand-in covering only what Peer touches. */
class FakePC {
  static last: FakePC | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: unknown = { type: 'offer', sdp: 'v=0' };
  restartIce = vi.fn();
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});
  createDataChannel = vi.fn(() => ({
    label: 'x',
    readyState: 'connecting',
    close: () => {},
    set onmessage(_v: unknown) {},
  }));
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  ondatachannel: unknown = null;
  onnegotiationneeded: unknown = null;
  constructor() {
    FakePC.last = this;
  }
  close(): void {}
}

function makePeer(role: 'host' | 'viewer') {
  const signaling = new FakeSignaling();
  const peer = new Peer({
    role,
    signaling: signaling as unknown as SignalingClient,
    rtcPeerConnection: FakePC as unknown as typeof RTCPeerConnection,
  });
  return { peer, signaling };
}

describe('Peer.restartIce', () => {
  it('returns false before start() (no connection)', () => {
    const { peer } = makePeer('host');
    expect(peer.isOpen).toBe(false);
    expect(peer.restartIce()).toBe(false);
  });

  it('host restarts ICE and emits a fresh offer once a peer is known', async () => {
    const { peer, signaling } = makePeer('host');
    await peer.start();
    expect(peer.isOpen).toBe(true);
    // A remote viewer joins → remoteId becomes known.
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-1' });
    const offersBefore = signaling.sent.filter((m) => m.type === 'offer').length;

    expect(peer.restartIce()).toBe(true);
    expect(FakePC.last!.restartIce).toHaveBeenCalledTimes(1);
    // Allow the queued negotiate() microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    const offersAfter = signaling.sent.filter((m) => m.type === 'offer').length;
    expect(offersAfter).toBe(offersBefore + 1);
  });

  it('host restartIce returns false with no remote peer yet', async () => {
    const { peer } = makePeer('host');
    await peer.start();
    expect(peer.restartIce()).toBe(false);
    // Still calls the underlying restartIce best-effort.
    expect(FakePC.last!.restartIce).toHaveBeenCalledTimes(1);
  });

  it('viewer restartIce signals readiness without originating an offer', async () => {
    const { peer, signaling } = makePeer('viewer');
    await peer.start();
    signaling.fire('offer', { type: 'offer', from: 'host-1', sdp: { type: 'offer', sdp: 'v=0' } });
    const offersBefore = signaling.sent.filter((m) => m.type === 'offer').length;
    // Viewer is polite: it never makes the offer; the host re-offers.
    peer.restartIce();
    await Promise.resolve();
    const offersAfter = signaling.sent.filter((m) => m.type === 'offer').length;
    expect(offersAfter).toBe(offersBefore);
  });
});
