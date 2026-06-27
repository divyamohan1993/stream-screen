import { describe, it, expect, vi } from 'vitest';
import { Peer } from '../src/peer.js';
import { encodeInput } from '../src/input-codec.js';
import type { InputEvent, SignalMessage } from '../src/protocol.js';
import type { SignalingClient } from '../src/signaling-client.js';

/**
 * Multi-viewer fan-out at the Peer layer: the host must maintain ONE
 * RTCPeerConnection (with its own senders + data channels) per viewer, keyed by
 * the server's per-peer ids, so a second viewer can never overwrite/steal the
 * first's connection or collide on a single shared input channel.
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

/** A data channel stub that records what is sent and lets tests inject inbound messages. */
class FakeChannel {
  readyState = 'open';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public label: string) {}
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** RTCPeerConnection stub that exposes the channels it created + its senders. */
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

describe('Peer multi-viewer (host)', () => {
  it('creates a separate connection per viewer and offers each independently', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();

    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    expect(peer.connectionCount).toBe(2);
    expect(peer.remoteIds.sort()).toEqual(['viewer-A', 'viewer-B']);
    // One PC per viewer — the second join did not overwrite the first.
    expect(FakePC.instances).toHaveLength(2);
  });

  it('a second viewer does not steal the first viewer connection', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    const firstPc = FakePC.instances[0];
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });
    // The first viewer's PC still exists and was not closed/replaced.
    expect(FakePC.instances[0]).toBe(firstPc);
    expect(peer.connectionCount).toBe(2);
  });

  it('attaches media to every existing viewer and replays it to later joiners', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });

    const track = { kind: 'video' } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    peer.attachStream(stream);

    // Existing viewer A got the track.
    expect(FakePC.instances[0].senders.map((s) => s.track.kind)).toEqual(['video']);

    // A later viewer B should have the track replayed onto its fresh connection.
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });
    expect(FakePC.instances[1].senders.map((s) => s.track.kind)).toEqual(['video']);
  });

  it('attributes inbound input to the originating viewer (no channel collision)', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    const received: Array<{ e: InputEvent; id: string }> = [];
    peer.onInput((e, remoteId) => received.push({ e, id: remoteId }));

    const chA = FakePC.instances[0].channels.get('input')!;
    const chB = FakePC.instances[1].channels.get('input')!;
    const moveA: InputEvent = { t: 'm-move', x: 0.1, y: 0.2 };
    const moveB: InputEvent = { t: 'm-move', x: 0.8, y: 0.9 };
    chA.onmessage!({ data: encodeInput(moveA) });
    chB.onmessage!({ data: encodeInput(moveB) });

    expect(received).toEqual([
      { e: moveA, id: 'viewer-A' },
      { e: moveB, id: 'viewer-B' },
    ]);
  });

  it('applyDecision sets maintain-resolution + encodings on every viewer sender', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    const track = { kind: 'video' } as unknown as MediaStreamTrack;
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    peer.attachStream(stream);

    await peer.applyDecision({
      targetKbps: 4000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
      reason: 'test',
    });

    for (const pc of FakePC.instances) {
      const sender = pc.senders.find((s) => s.track.kind === 'video')!;
      // Drop framerate before resolution so remote-desktop text stays sharp.
      expect(sender.params.degradationPreference).toBe('maintain-resolution');
      expect(sender.params.encodings).toEqual([
        { maxBitrate: 4_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
      ]);
    }
  });

  it('broadcasts control to all viewers but can target one', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    peer.sendControl({ t: 'chat', text: 'hi all', ts: 1 });
    const ctlA = FakePC.instances[0].channels.get('control')!;
    const ctlB = FakePC.instances[1].channels.get('control')!;
    expect(ctlA.sent).toHaveLength(1);
    expect(ctlB.sent).toHaveLength(1);

    peer.sendControl({ t: 'chat', text: 'only A', ts: 2 }, 'viewer-A');
    expect(ctlA.sent).toHaveLength(2);
    expect(ctlB.sent).toHaveLength(1);
  });

  it('drops only the departing viewer connection on peer-left', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });
    expect(peer.connectionCount).toBe(2);

    signaling.fire('peer-left', { type: 'peer-left', from: 'viewer-A' });
    expect(peer.connectionCount).toBe(1);
    expect(peer.remoteIds).toEqual(['viewer-B']);
  });

  it('routes ICE candidates to the right per-viewer connection', async () => {
    const { peer, signaling } = makeHost();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    // Apply a remote description first so candidates are added, not queued.
    signaling.fire('answer', {
      type: 'answer',
      from: 'viewer-A',
      sdp: { type: 'answer', sdp: 'v=0' },
    });
    await Promise.resolve();
    signaling.fire('ice', {
      type: 'ice',
      from: 'viewer-A',
      candidate: { candidate: 'a', sdpMid: '0' },
    });
    await Promise.resolve();

    expect(FakePC.instances[0].addIceCandidate).toHaveBeenCalledTimes(1);
    expect(FakePC.instances[1].addIceCandidate).not.toHaveBeenCalled();
  });
});
