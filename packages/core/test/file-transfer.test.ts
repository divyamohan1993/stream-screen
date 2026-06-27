import { describe, it, expect } from 'vitest';
import {
  chunkBuffer,
  parseChunk,
  frameChunk,
  createSender,
  createReceiver,
  ReceiverRouter,
  FileTransferManager,
  DEFAULT_CHUNK_SIZE,
  CHUNK_HEADER_BYTES,
  CHUNK_ID_LEN_BYTES,
} from '../src/file-transfer.js';
import type { ControlMessage } from '../src/protocol.js';
import type { FileMeta } from '../src/file-transfer.js';

/** Deterministic pseudo-random byte array of a given length. */
function bytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  let x = 0x9e3779b1 ^ n;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    a[i] = x & 0xff;
  }
  return a;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const SIZES = [0, 1, 2, 100, 16383, 16384, 16385, 32768, 40000, 65536];

describe('chunkBuffer / parseChunk framing', () => {
  it('round-trips arbitrary sizes incl. 0, 1, exact multiples', () => {
    for (const size of SIZES) {
      const data = bytes(size);
      const chunks = chunkBuffer('t', data);
      // reassemble
      const out = new Uint8Array(size);
      let off = 0;
      let expectedSeq = 0;
      for (const c of chunks) {
        const { id, seq, len, payload } = parseChunk(c);
        expect(id).toBe('t');
        expect(seq).toBe(expectedSeq++);
        expect(len).toBe(payload.byteLength);
        out.set(payload, off);
        off += payload.byteLength;
      }
      expect(off).toBe(size);
      expect(eq(out, data)).toBe(true);
    }
  });

  it('embeds the transfer id in every frame', () => {
    const chunks = chunkBuffer('abc-123', bytes(40000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(parseChunk(c).id).toBe('abc-123');
  });

  it('emits exactly one empty chunk for zero-length input', () => {
    const chunks = chunkBuffer('t', new Uint8Array(0));
    expect(chunks).toHaveLength(1);
    // Header = id-len prefix + id bytes ('t' = 1 byte) + fixed header.
    expect(chunks[0].byteLength).toBe(CHUNK_ID_LEN_BYTES + 1 + CHUNK_HEADER_BYTES);
    expect(parseChunk(chunks[0]).payload.byteLength).toBe(0);
  });

  it('chunk count matches ceil(size/chunkSize) for non-empty inputs', () => {
    const size = 40000;
    const chunks = chunkBuffer('t', bytes(size));
    expect(chunks).toHaveLength(Math.ceil(size / DEFAULT_CHUNK_SIZE));
  });

  it('honors a custom chunk size and exact multiples', () => {
    const chunks = chunkBuffer('t', bytes(40), 10);
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(parseChunk(c).payload.byteLength).toBe(10);
  });

  it('rejects a chunkSize <= 0', () => {
    expect(() => chunkBuffer('t', bytes(10), 0)).toThrow();
  });

  it('parseChunk detects truncation / corruption', () => {
    const good = frameChunk('t', 3, bytes(100));
    // Truncate the payload: declared length no longer matches.
    const truncated = good.slice(0, good.byteLength - 5);
    expect(() => parseChunk(truncated)).toThrow();
    // Frame shorter than the id-length prefix.
    expect(() => parseChunk(new ArrayBuffer(1))).toThrow();
    // Frame shorter than the full header (id-len says 4 but buffer is tiny).
    const short = new ArrayBuffer(CHUNK_ID_LEN_BYTES);
    new DataView(short).setUint16(0, 4, true);
    expect(() => parseChunk(short)).toThrow();
  });
});

describe('createReceiver reassembly', () => {
  function meta(size: number): FileMeta {
    return { id: 'x', name: 'f.bin', size, mime: 'application/octet-stream' };
  }

  it('reassembles in-order chunks for every size', () => {
    for (const size of SIZES) {
      const data = bytes(size);
      const r = createReceiver({ meta: meta(size) });
      for (const c of chunkBuffer('x', data)) r.push(c);
      expect(eq(r.finish(), data)).toBe(true);
    }
  });

  it('reassembles out-of-order chunks correctly', () => {
    const size = 40000;
    const data = bytes(size);
    const chunks = chunkBuffer('x', data);
    const shuffled = [...chunks].reverse();
    const r = createReceiver({ meta: meta(size) });
    for (const c of shuffled) r.push(c);
    expect(eq(r.finish(), data)).toBe(true);
  });

  it('fires onComplete with the reassembled bytes', () => {
    const size = 20000;
    const data = bytes(size);
    let got: Uint8Array | null = null;
    const r = createReceiver({ meta: meta(size), onComplete: (d) => (got = d) });
    for (const c of chunkBuffer('x', data)) r.push(c);
    r.finish();
    expect(got).not.toBeNull();
    expect(eq(got!, data)).toBe(true);
  });

  it('throws on duplicate chunk seq', () => {
    const data = bytes(40000);
    const chunks = chunkBuffer('x', data);
    const r = createReceiver({ meta: meta(data.byteLength) });
    r.push(chunks[0]);
    expect(() => r.push(chunks[0])).toThrow(/duplicate/);
  });

  it('throws on a missing chunk (gap) at finish', () => {
    const data = bytes(40000);
    const chunks = chunkBuffer('x', data);
    const r = createReceiver({ meta: meta(data.byteLength) });
    // Skip the middle chunk.
    r.push(chunks[0]);
    r.push(chunks[2]);
    expect(() => r.finish()).toThrow(/missing/);
  });

  it('throws when reassembled size != offered size', () => {
    const data = bytes(16384);
    const r = createReceiver({ meta: meta(99999) });
    for (const c of chunkBuffer('x', data)) r.push(c);
    expect(() => r.finish()).toThrow(/size/);
  });

  it('rejects a chunk framed for a different transfer id', () => {
    const data = bytes(16384);
    const r = createReceiver({ meta: meta(data.byteLength) }); // id 'x'
    const foreign = chunkBuffer('y', data)[0];
    expect(() => r.push(foreign)).toThrow(/id/);
  });
});

describe('createSender + createReceiver end-to-end', () => {
  it('moves a file across the offer/accept/chunk/complete handshake', async () => {
    for (const size of [0, 1, 16384, 40000, 65536]) {
      const data = bytes(size);
      const meta: FileMeta = { id: 't', name: 'a', size, mime: 'application/octet-stream' };

      const control: ControlMessage[] = [];
      let receiver = createReceiver({ meta });

      const sender = createSender({
        meta,
        data,
        send: (m) => {
          control.push(m);
          if (m.t === 'file-complete') {
            // nothing — finish is driven by the test below
          }
        },
        sendChunk: (buf) => {
          receiver.push(buf);
        },
      });

      const done = sender.start();
      // Simulate the receiver accepting the offer.
      sender.accept();
      await done;

      // The offer must precede the complete; progress in between.
      expect(control[0].t).toBe('file-offer');
      expect(control[control.length - 1].t).toBe('file-complete');
      const progresses = control.filter((m) => m.t === 'file-progress');
      // At least one progress unless empty file (still one chunk → one progress).
      expect(progresses.length).toBeGreaterThanOrEqual(1);

      expect(eq(receiver.finish(), data)).toBe(true);
    }
  });

  it('awaits the drain hook before each chunk for backpressure', async () => {
    const data = bytes(40000);
    const meta: FileMeta = { id: 'd', name: 'a', size: data.byteLength, mime: 'x' };
    let drains = 0;
    const receiver = createReceiver({ meta });
    const sender = createSender({
      meta,
      data,
      send: () => {},
      sendChunk: (buf) => receiver.push(buf),
      drain: () => {
        drains += 1;
      },
    });
    const done = sender.start();
    sender.accept();
    await done;
    expect(drains).toBe(chunkBuffer(meta.id, data).length);
    expect(eq(receiver.finish(), data)).toBe(true);
  });

  it('abort rejects the sender start promise', async () => {
    const data = bytes(100);
    const meta: FileMeta = { id: 'z', name: 'a', size: data.byteLength, mime: 'x' };
    const sender = createSender({ meta, data, send: () => {}, sendChunk: () => {} });
    const done = sender.start();
    sender.abort('rejected by peer');
    await expect(done).rejects.toThrow(/rejected by peer/);
  });
});

describe('FileTransferManager', () => {
  it('routes control + chunks through to a completed file', () => {
    const size = 40000;
    const data = bytes(size);
    const meta: FileMeta = { id: 'm1', name: 'a', size, mime: 'x' };

    let delivered: Uint8Array | null = null;
    const sent: ControlMessage[] = [];
    const mgr = new FileTransferManager(
      (d) => (delivered = d),
      (m) => sent.push(m),
      true, // auto-accept
    );

    mgr.onControl({ t: 'file-offer', id: meta.id, name: meta.name, size, mime: meta.mime });
    expect(sent.some((m) => m.t === 'file-accept' && m.id === meta.id)).toBe(true);
    expect(mgr.has(meta.id)).toBe(true);

    for (const c of chunkBuffer(meta.id, data)) mgr.onChunk(c);
    mgr.onControl({ t: 'file-complete', id: meta.id });

    expect(delivered).not.toBeNull();
    expect(eq(delivered!, data)).toBe(true);
    expect(mgr.has(meta.id)).toBe(false);
  });

  it('drops a receiver on reject/error', () => {
    const mgr = new FileTransferManager(() => {});
    mgr.onControl({ t: 'file-offer', id: 'r', name: 'a', size: 1, mime: 'x' });
    expect(mgr.has('r')).toBe(true);
    mgr.onControl({ t: 'file-reject', id: 'r' });
    expect(mgr.has('r')).toBe(false);
  });

  it('reassembles two transfers whose chunks arrive INTERLEAVED without cross-contamination', () => {
    // Regression for the misrouting bug: a second file-offer arriving before the
    // first file's chunks finish must NOT push the first file's remaining chunks
    // into the second receiver.
    const sizeA = 40000;
    const sizeB = 50000;
    const dataA = bytes(sizeA);
    const dataB = bytes(sizeB).map((b) => b ^ 0xff); // distinct content
    const metaA: FileMeta = { id: 'A', name: 'a', size: sizeA, mime: 'x' };
    const metaB: FileMeta = { id: 'B', name: 'b', size: sizeB, mime: 'x' };

    const delivered = new Map<string, Uint8Array>();
    const mgr = new FileTransferManager((d, m) => delivered.set(m.id, d));

    // Both offers arrive (B before A's chunks complete).
    mgr.onControl({ t: 'file-offer', ...metaA });
    mgr.onControl({ t: 'file-offer', ...metaB });

    const chunksA = chunkBuffer('A', dataA);
    const chunksB = chunkBuffer('B', dataB);

    // Interleave the two chunk streams arbitrarily.
    const max = Math.max(chunksA.length, chunksB.length);
    for (let i = 0; i < max; i++) {
      if (i < chunksA.length) mgr.onChunk(chunksA[i]);
      if (i < chunksB.length) mgr.onChunk(chunksB[i]);
    }

    mgr.onControl({ t: 'file-complete', id: 'A' });
    mgr.onControl({ t: 'file-complete', id: 'B' });

    expect(delivered.has('A')).toBe(true);
    expect(delivered.has('B')).toBe(true);
    expect(delivered.get('A')!.byteLength).toBe(sizeA);
    expect(delivered.get('B')!.byteLength).toBe(sizeB);
    expect(eq(delivered.get('A')!, dataA)).toBe(true);
    expect(eq(delivered.get('B')!, dataB)).toBe(true);
  });
});

describe('ReceiverRouter', () => {
  function meta(id: string, size: number): FileMeta {
    return { id, name: `${id}.bin`, size, mime: 'application/octet-stream' };
  }

  it('routes interleaved chunks from two senders to their own receivers', () => {
    const sizeA = 40000;
    const sizeB = 33000;
    const dataA = bytes(sizeA);
    const dataB = bytes(sizeB).map((b) => (b + 7) & 0xff);

    const router = new ReceiverRouter();
    const rA = createReceiver({ meta: meta('A', sizeA) });
    const rB = createReceiver({ meta: meta('B', sizeB) });
    router.register('A', rA);
    router.register('B', rB);

    const chunksA = chunkBuffer('A', dataA);
    const chunksB = chunkBuffer('B', dataB);
    const max = Math.max(chunksA.length, chunksB.length);
    for (let i = 0; i < max; i++) {
      // Deliberately deliver B before A on each step to maximise interleaving.
      if (i < chunksB.length) expect(router.handleChunk(chunksB[i])).toBe(rB);
      if (i < chunksA.length) expect(router.handleChunk(chunksA[i])).toBe(rA);
    }

    expect(eq(rA.finish(), dataA)).toBe(true);
    expect(eq(rB.finish(), dataB)).toBe(true);
  });

  it('drops chunks for an unknown id (no misrouting)', () => {
    const router = new ReceiverRouter();
    const r = createReceiver({ meta: meta('known', 16384) });
    router.register('known', r);
    const orphan = chunkBuffer('unknown', bytes(16384))[0];
    expect(router.handleChunk(orphan)).toBeUndefined();
    expect(r.received).toBe(0);
  });

  it('register/unregister/has/get track receivers', () => {
    const router = new ReceiverRouter();
    const r = createReceiver({ meta: meta('z', 1) });
    expect(router.has('z')).toBe(false);
    router.register('z', r);
    expect(router.has('z')).toBe(true);
    expect(router.get('z')).toBe(r);
    router.unregister('z');
    expect(router.has('z')).toBe(false);
    expect(router.get('z')).toBeUndefined();
  });
});
