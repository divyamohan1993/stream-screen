import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, FileMeta } from '@stream-screen/core';

/**
 * Regression tests for CONCURRENT, interleaved file transfers over the single
 * binary `file` channel after adopting the core transfer-id routing API.
 *
 * The viewer file picker lets the user select MULTIPLE files at once, producing
 * several senders that share one binary channel, and the host can likewise push
 * several files at once. Each binary frame now carries its OWN transfer id, and
 * the viewer routes inbound frames (via core's {@link FileTransferManager} →
 * {@link ReceiverRouter}) by that embedded id.
 *
 * These tests deliberately INTERLEAVE the chunks of two transfers. Under the old
 * "route by last-offered id" behavior the interleaved frames would land in the
 * wrong receiver and corrupt both files; under id-routing each transfer must
 * reassemble to its OWN exact bytes.
 *
 * The real core encode/decode + manager are used; only `Peer`/`SignalingClient`
 * are faked so no real WebRTC is needed.
 */

class FakePeer {
  static current: FakePeer | null = null;
  controlCb: ((m: ControlMessage) => void) | null = null;
  chunkCb: ((b: ArrayBuffer) => void) | null = null;
  inputCb: ((e: InputEvent) => void) | null = null;
  sentControl: ControlMessage[] = [];
  sentChunks: ArrayBuffer[] = [];

  constructor() {
    FakePeer.current = this;
  }
  on(): void {}
  async start(): Promise<void> {}
  sendControl(m: ControlMessage): void {
    this.sentControl.push(m);
  }
  onControl(cb: (m: ControlMessage) => void): void {
    this.controlCb = cb;
  }
  sendFileChunk(b: ArrayBuffer): void {
    this.sentChunks.push(b);
  }
  onFileChunk(cb: (b: ArrayBuffer) => void): void {
    this.chunkCb = cb;
  }
  getFileBufferedAmount(): number {
    return 0;
  }
  async drainFile(): Promise<void> {}
  sendInput(): void {}
  onInput(cb: (e: InputEvent) => void): void {
    this.inputCb = cb;
  }
  close(): void {}
}

class FakeSignaling {
  private handlers = new Map<string, (m: unknown) => void>();
  on(ev: string, cb: (m: unknown) => void): void {
    this.handlers.set(ev, cb);
  }
  off(ev: string, _cb: (m: unknown) => void): void {
    this.handlers.delete(ev);
  }
  async connect(): Promise<void> {}
  join(): void {
    // Mirror the signaling contract: a successful join is acknowledged with
    // `joined`, which the session awaits before resolving connect().
    this.handlers.get('joined')?.({ type: 'joined' });
  }
  close(): void {}
}

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return {
    ...actual,
    Peer: FakePeer,
    SignalingClient: FakeSignaling,
  };
});

const { ViewerSession } = await import('./viewer-session.js');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;

async function connectedSession(handlers: Handlers = {}) {
  const session = new ViewerSession({ code: '123456', signalingUrl: 'ws://x:8787', handlers });
  await session.connect();
  return session;
}

describe('ViewerSession concurrent inbound transfers (id routing, no cross-contamination)', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('demuxes TWO interleaved inbound transfers to their own exact bytes', async () => {
    const ready = new Map<string, Uint8Array>();
    await connectedSession({
      onFileReady: (data, meta) => ready.set(meta.id, data),
    });
    const peer = FakePeer.current!;
    const { frameChunk } = await import('@stream-screen/core');

    // Two distinct files whose chunk payloads, if misrouted, would corrupt the
    // other transfer (different content AND different chunk counts).
    const a = new Uint8Array([10, 11, 12, 13, 14, 15]); // 2 chunks of 3
    const b = new Uint8Array([90, 91, 92, 93]); // 2 chunks of 2

    const metaA: FileMeta = { id: 'A', name: 'a.bin', size: a.byteLength, mime: 'application/octet-stream' };
    const metaB: FileMeta = { id: 'B', name: 'b.bin', size: b.byteLength, mime: 'application/octet-stream' };

    // Both offers arrive (second offer BEFORE first file's chunks finish).
    peer.controlCb!({ t: 'file-offer', ...metaA });
    peer.controlCb!({ t: 'file-offer', ...metaB });
    // Both auto-accepted.
    expect(peer.sentControl).toContainEqual({ t: 'file-accept', id: 'A' });
    expect(peer.sentControl).toContainEqual({ t: 'file-accept', id: 'B' });

    // INTERLEAVE chunks from A and B on the one binary channel.
    peer.chunkCb!(frameChunk('A', 0, a.subarray(0, 3)));
    peer.chunkCb!(frameChunk('B', 0, b.subarray(0, 2)));
    peer.chunkCb!(frameChunk('A', 1, a.subarray(3, 6)));
    peer.chunkCb!(frameChunk('B', 1, b.subarray(2, 4)));

    // Complete in reverse order to further stress the routing.
    peer.controlCb!({ t: 'file-complete', id: 'B' });
    peer.controlCb!({ t: 'file-complete', id: 'A' });

    // Each transfer reassembled to its OWN exact bytes — no cross-contamination.
    expect(ready.get('A')).toEqual(a);
    expect(ready.get('B')).toEqual(b);
  });

  it('drops binary chunks for an unknown/unregistered transfer id (no misroute)', async () => {
    const ready = new Map<string, Uint8Array>();
    await connectedSession({
      onFileReady: (data, meta) => ready.set(meta.id, data),
    });
    const peer = FakePeer.current!;
    const { frameChunk } = await import('@stream-screen/core');

    const a = new Uint8Array([1, 2, 3]);
    peer.controlCb!({ t: 'file-offer', id: 'A', name: 'a.bin', size: a.byteLength, mime: '' });

    // A stray frame for an id that was never offered must NOT corrupt A.
    peer.chunkCb!(frameChunk('GHOST', 0, new Uint8Array([255, 255, 255, 255])));
    peer.chunkCb!(frameChunk('A', 0, a));
    peer.controlCb!({ t: 'file-complete', id: 'A' });

    expect(ready.get('A')).toEqual(a);
    expect(ready.has('GHOST')).toBe(false);
  });
});

describe('ViewerSession concurrent outbound senders (unique ids per selected file)', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('selecting multiple files starts multiple uniquely-id\'d senders that do not corrupt each other', async () => {
    const session = await connectedSession();
    const peer = FakePeer.current!;
    const { parseChunk } = await import('@stream-screen/core');

    const dataA = new Uint8Array([1, 1, 1, 1, 1]);
    const dataB = new Uint8Array([2, 2, 2]);

    // Two files chosen "at once" -> two senders sharing one channel.
    const idA = session.sendFile({ name: 'a.bin', size: dataA.byteLength, type: '' }, dataA);
    const idB = session.sendFile({ name: 'b.bin', size: dataB.byteLength, type: '' }, dataB);

    // Each sender got a UNIQUE id.
    expect(idA).not.toBe(idB);

    // Two distinct offers went out, one per id.
    const offers = peer.sentControl.filter((m) => m.t === 'file-offer');
    expect(offers.map((m) => (m as { id: string }).id).sort()).toEqual([idA, idB].sort());

    // Accept both; chunks then stream interleaved on the shared channel.
    peer.controlCb!({ t: 'file-accept', id: idA });
    peer.controlCb!({ t: 'file-accept', id: idB });
    await new Promise((r) => setTimeout(r, 0));

    // Every emitted binary frame embeds the id of exactly one transfer, and the
    // payload bytes match that transfer's content (no cross-contamination).
    const seen = new Set<string>();
    for (const buf of peer.sentChunks) {
      const { id, payload } = parseChunk(buf);
      seen.add(id);
      const expectedByte = id === idA ? 1 : 2;
      for (const byte of payload) expect(byte).toBe(expectedByte);
    }
    expect(seen).toEqual(new Set([idA, idB]));

    // Both completed independently.
    const completes = peer.sentControl.filter((m) => m.t === 'file-complete').map((m) => (m as { id: string }).id);
    expect(completes.sort()).toEqual([idA, idB].sort());
  });
});
