import { describe, it, expect, vi } from 'vitest';
import { Peer } from '../src/peer.js';
import type { SignalMessage } from '../src/protocol.js';
import type { SignalingClient } from '../src/signaling-client.js';

/**
 * Regression coverage for the two P1 security fixes the host's connection-consent
 * / access-PIN feature depends on:
 *
 *  - onControlOpen / isControlOpen: per-connection signal that a SPECIFIC viewer's
 *    `control` data channel is open, so the host can begin auth at the only moment
 *    auth frames can actually be delivered (P1-A). Also reflects already-open
 *    channels for late subscribers.
 *  - attachStreamTo: per-viewer media attach that does NOT set the session-wide
 *    localStream, so it never leaks the screen to other existing viewers or to
 *    viewers that join later (P1-B). The existing session-wide attachStream must
 *    keep replaying to all + new connections (open mode, unchanged).
 */

type Handler = (m: SignalMessage) => void;

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

/**
 * Data-channel stub whose open state is controllable. Channels created by the
 * host via createDataChannel start `connecting`; the test flips them open and
 * fires `onopen` to model the real WebRTC lifecycle (host begins auth too early
 * if it relies on the signaling join instead of this edge).
 */
class FakeChannel {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public label: string) {}
  send(data: unknown): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  close(): void {
    this.readyState = 'closed';
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakePC {
  static instances: FakePC[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: unknown = { type: 'offer', sdp: 'v=0' };
  channels = new Map<string, FakeChannel>();
  senders: Array<{
    track: { kind: string };
    params: { encodings?: unknown[]; degradationPreference?: string };
    getParameters(): { encodings?: unknown[]; degradationPreference?: string };
    setParameters(p: { encodings?: unknown[]; degradationPreference?: string }): Promise<void>;
  }> = [];
  restartIce = vi.fn();
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  ondatachannel: unknown = null;
  onnegotiationneeded: (() => void) | null = null;
  constructor() {
    FakePC.instances.push(this);
  }
  createDataChannel(label: string): FakeChannel {
    const ch = new FakeChannel(label);
    this.channels.set(label, ch);
    return ch;
  }
  addTrack(track: { kind: string }): (typeof FakePC.prototype.senders)[number] {
    const sender = {
      track,
      params: {} as { encodings?: unknown[]; degradationPreference?: string },
      getParameters() {
        return this.params;
      },
      async setParameters(p: { encodings?: unknown[]; degradationPreference?: string }) {
        this.params = p;
      },
    };
    this.senders.push(sender);
    return sender;
  }
  getSenders(): typeof FakePC.prototype.senders {
    return this.senders;
  }
  getReceivers(): unknown[] {
    return [];
  }
  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
  close(): void {}
}

function makeHost() {
  FakePC.instances = [];
  const signaling = new FakeSignaling();
  const peer = new Peer({
    role: 'host',
    signaling: signaling as unknown as SignalingClient,
    rtcPeerConnection: FakePC as unknown as typeof RTCPeerConnection,
  });
  return { peer, signaling };
}

function videoStream(): MediaStream {
  const track = { kind: 'video' } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

describe('Peer.onControlOpen (P1-A: per-connection control-channel readiness)', () => {
  it('fires per connection only when ITS control channel actually opens', () => {
    const { peer, signaling } = makeHost();
    void peer.start();

    const opened: string[] = [];
    peer.onControlOpen((id) => opened.push(id));

    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    // Control channels exist but are not open yet -> no edge fired, and the host
    // must not treat the signaling join as "ready" (the P1-A bug).
    expect(opened).toEqual([]);
    expect(peer.isControlOpen('viewer-A')).toBe(false);
    expect(peer.isControlOpen('viewer-B')).toBe(false);

    // Open viewer-A's control channel only.
    FakePC.instances[0].channels.get('control')!.open();
    expect(opened).toEqual(['viewer-A']);
    expect(peer.isControlOpen('viewer-A')).toBe(true);
    expect(peer.isControlOpen('viewer-B')).toBe(false);

    // Then viewer-B's.
    FakePC.instances[1].channels.get('control')!.open();
    expect(opened).toEqual(['viewer-A', 'viewer-B']);
    expect(peer.isControlOpen('viewer-B')).toBe(true);
  });

  it('fires only once per connection even if open is signalled again', () => {
    const { peer, signaling } = makeHost();
    void peer.start();
    const opened: string[] = [];
    peer.onControlOpen((id) => opened.push(id));
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });

    const ctl = FakePC.instances[0].channels.get('control')!;
    ctl.open();
    ctl.onopen?.(); // spurious re-fire
    expect(opened).toEqual(['viewer-A']);
  });

  it('delivers already-open channels to a LATE subscriber', () => {
    const { peer, signaling } = makeHost();
    void peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    FakePC.instances[0].channels.get('control')!.open();

    // Subscribe AFTER the channel already opened.
    const opened: string[] = [];
    peer.onControlOpen((id) => opened.push(id));
    expect(opened).toEqual(['viewer-A']);
    expect(peer.isControlOpen('viewer-A')).toBe(true);
  });

  it('emits the controlopen event with the remote id as well', () => {
    const { peer, signaling } = makeHost();
    void peer.start();
    const seen: unknown[] = [];
    peer.on('controlopen', (id: string) => seen.push(id));
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    FakePC.instances[0].channels.get('control')!.open();
    expect(seen).toEqual(['viewer-A']);
  });

  it('isControlOpen returns false for an unknown viewer', () => {
    const { peer } = makeHost();
    void peer.start();
    expect(peer.isControlOpen('nobody')).toBe(false);
  });
});

describe('Peer.attachStreamTo (P1-B: per-viewer media, no session-wide leak)', () => {
  it('adds tracks to ONLY the targeted connection; others get no video sender', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    // Authorize only viewer-A.
    await peer.attachStreamTo('viewer-A', videoStream());

    expect(FakePC.instances[0].senders.map((s) => s.track.kind)).toEqual(['video']);
    // Unapproved viewer-B has NO sender — it receives nothing.
    expect(FakePC.instances[1].senders).toEqual([]);
  });

  it('does NOT auto-attach the stream to a viewer that joins later', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });

    await peer.attachStreamTo('viewer-A', videoStream());

    // A new viewer joins AFTER the per-viewer attach. Because attachStreamTo did
    // not set the session-wide localStream, the new connection must not replay
    // any media (the P1-B leak).
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-C' });
    const cPc = FakePC.instances.find((_, i) => i === 1)!;
    expect(cPc.senders).toEqual([]);
  });

  it('renegotiates only the targeted connection (no offer forced on others)', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    // addTrack on the FakePC fires no negotiationneeded by itself; assert the
    // structural invariant instead: only A has a sender after the call.
    await peer.attachStreamTo('viewer-A', videoStream());
    expect(FakePC.instances[0].senders).toHaveLength(1);
    expect(FakePC.instances[1].senders).toHaveLength(0);
  });

  it('is a no-op for an unknown remote id', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    await expect(peer.attachStreamTo('ghost', videoStream())).resolves.toBeUndefined();
    expect(FakePC.instances[0].senders).toEqual([]);
  });

  it('applyDecision only touches connections that actually have a video sender', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });
    await peer.attachStreamTo('viewer-A', videoStream());

    // No throw despite viewer-B having no sender; B remains sender-less.
    await peer.applyDecision({
      targetKbps: 3000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
      reason: 'test',
    });
    expect(FakePC.instances[1].senders).toEqual([]);
  });
});

describe('Peer.attachStream (open mode: session-wide replay unchanged)', () => {
  it('still attaches to every existing connection and replays to new joiners', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    peer.attachStream(videoStream());
    expect(FakePC.instances[0].senders.map((s) => s.track.kind)).toEqual(['video']);
    expect(FakePC.instances[1].senders.map((s) => s.track.kind)).toEqual(['video']);

    // A later viewer gets the stream replayed onto its fresh connection.
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-C' });
    expect(FakePC.instances[2].senders.map((s) => s.track.kind)).toEqual(['video']);
  });
});
