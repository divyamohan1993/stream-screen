import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, SignalMessage } from '@stream-screen/core';

/**
 * Regression for P2-1 (viewer drops a host offer that beats its Peer setup).
 *
 * On a fast LAN the signaling server can route the host's `offer` to the viewer
 * the instant the viewer's `join` is acknowledged — BEFORE the viewer has built
 * and started its {@link Peer} and so before the peer's `offer` handler is
 * registered. The core {@link SignalingClient} now BUFFERS unhandled
 * offer/answer/ice frames and REPLAYS them the moment a handler is registered, so
 * the first offer is no longer dropped: the viewer processes it, the peer's track
 * arrives, and the viewer leaves `waiting-for-host`.
 *
 * This test mirrors that contract with a FakeSignaling that buffers `offer`
 * frames until an `offer` handler is registered (exactly what core does), and a
 * FakePeer whose `start()` registers an `offer` handler via `signaling.on` (as
 * the real Peer does in `wireSignaling`). It proves an offer fired immediately
 * after `join()` — while no peer handler exists yet — is still delivered to the
 * peer (which then surfaces its track), so the viewer never stays stuck waiting.
 */

type StateCb = (s: RTCPeerConnectionState) => void;
type TrackCb = (track: MediaStreamTrack, stream: MediaStream) => void;

let signalingForPeer: FakeSignaling | null = null;

class FakePeer {
  static instances: FakePeer[] = [];
  static current: FakePeer | null = null;
  stateCb: StateCb | null = null;
  trackCb: TrackCb | null = null;
  started = false;
  closed = false;
  offersHandled = 0;
  private readonly signaling: FakeSignaling;

  constructor() {
    FakePeer.instances.push(this);
    FakePeer.current = this;
    // The real Peer is constructed over the same SignalingClient the session
    // uses. Capture it so start() can register the `offer` handler against it.
    this.signaling = signalingForPeer!;
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'state') this.stateCb = cb as StateCb;
    if (ev === 'track') this.trackCb = cb as TrackCb;
  }
  async start(): Promise<void> {
    this.started = true;
    // Mirror Peer.wireSignaling: register the offer handler at start(). The core
    // SignalingClient replays any buffered offer to it right here. Receiving the
    // offer drives negotiation; we model "negotiation completed" by surfacing a
    // track and going connected so the viewer leaves waiting-for-host.
    this.signaling.on('offer', () => {
      this.offersHandled++;
      const stream = { id: 'remote' } as unknown as MediaStream;
      const track = { kind: 'video' } as unknown as MediaStreamTrack;
      this.trackCb?.(track, stream);
      this.stateCb?.('connected');
    });
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
 * A signaling fake that replicates the core buffer-and-replay contract for
 * `offer` frames: an `offer` dispatched while no `offer` handler is registered is
 * BUFFERED and replayed the moment `on('offer', …)` is called. On `join()` it
 * acknowledges with `joined` and then IMMEDIATELY emits a host `offer` — the
 * fast-LAN race — before the session has built/started its peer.
 */
class FakeSignaling {
  static instances: FakeSignaling[] = [];
  joins = 0;
  connects = 0;
  closed = false;
  private handlers = new Map<string, Set<(m: SignalMessage) => void>>();
  private bufferedOffers: SignalMessage[] = [];

  constructor() {
    FakeSignaling.instances.push(this);
    signalingForPeer = this;
  }
  on(ev: string, cb: (m: SignalMessage) => void): void {
    let set = this.handlers.get(ev);
    if (!set) {
      set = new Set();
      this.handlers.set(ev, set);
    }
    set.add(cb);
    // Replay buffered offers to a freshly-registered offer handler (core contract).
    if (ev === 'offer' && this.bufferedOffers.length > 0) {
      const replay = this.bufferedOffers;
      this.bufferedOffers = [];
      for (const m of replay) cb(m);
    }
  }
  off(ev: string, cb: (m: SignalMessage) => void): void {
    this.handlers.get(ev)?.delete(cb);
  }
  private dispatch(ev: string, m: SignalMessage): void {
    const set = this.handlers.get(ev);
    if (set && set.size > 0) {
      for (const cb of set) cb(m);
    } else if (ev === 'offer') {
      this.bufferedOffers.push(m);
    }
  }
  async connect(): Promise<void> {
    this.connects++;
  }
  join(): void {
    this.joins++;
    // Acknowledge the join, then IMMEDIATELY route a host offer — the fast-LAN
    // race where the offer arrives before the viewer's peer handler exists.
    this.dispatch('joined', { type: 'joined' } as SignalMessage);
    this.dispatch('offer', { type: 'offer', from: 'host', sdp: {} } as SignalMessage);
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

describe('ViewerSession fast host offer (P2-1)', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    FakePeer.current = null;
    FakeSignaling.instances = [];
    signalingForPeer = null;
  });

  it('processes a host offer that arrives immediately after join (offer not dropped)', async () => {
    const states: string[] = [];
    let streamed = false;
    const handlers: Handlers = {
      onState: (s) => states.push(s),
      onStream: () => {
        streamed = true;
      },
    };
    const session = new ViewerSession({
      code: '123456',
      signalingUrl: 'ws://x:8787',
      handlers,
    });

    await session.connect();

    const peer = FakePeer.current!;
    // The buffered offer was replayed to the peer's handler the instant start()
    // registered it: the peer handled exactly one offer and surfaced its track.
    expect(peer.started).toBe(true);
    expect(peer.offersHandled).toBe(1);
    expect(streamed).toBe(true);
    // And the viewer left 'waiting-for-host' for 'connected' (not stuck waiting).
    expect(session.currentState).toBe('connected');
    expect(states).toContain('connected');
  });

  it('keeps the same offer-before-peer ordering safe across a reconnect rebuild', async () => {
    const states: string[] = [];
    const session = new ViewerSession({
      code: '123456',
      signalingUrl: 'ws://x:8787',
      reconnectGraceMs: 1000,
      handlers: { onState: (s) => states.push(s) },
    });
    await session.connect();
    expect(session.currentState).toBe('connected');

    // Force a hard failure → rebuild. The fresh signaling socket again fires the
    // offer immediately on join; the rebuilt peer must still handle it.
    vi.useFakeTimers();
    try {
      FakePeer.current!.stateCb?.('failed');
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }

    expect(FakePeer.instances).toHaveLength(2);
    const rebuilt = FakePeer.current!;
    expect(rebuilt.offersHandled).toBe(1);
    expect(session.currentState).toBe('connected');
  });
});
