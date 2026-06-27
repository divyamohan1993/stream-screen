import { describe, it, expect } from 'vitest';
import {
  chunkBuffer,
  parseChunk,
  frameChunk,
  createSender,
  createReceiver,
  FileTransferManager,
  DEFAULT_CHUNK_SIZE,
  CHUNK_HEADER_BYTES,
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
      const chunks = chunkBuffer(data);
      // reassemble
      const out = new Uint8Array(size);
      let off = 0;
      let expectedSeq = 0;
      for (const c of chunks) {
        const { seq, payload } = parseChunk(c);
        expect(seq).toBe(expectedSeq++);
        out.set(payload, off);
        off += payload.byteLength;
      }
      expect(off).toBe(size);
      expect(eq(out, data)).toBe(true);
    }
  });

  it('emits exactly one empty chunk for zero-length input', () => {
    const chunks = chunkBuffer(new Uint8Array(0));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].byteLength).toBe(CHUNK_HEADER_BYTES);
    expect(parseChunk(chunks[0]).payload.byteLength).toBe(0);
  });

  it('chunk count matches ceil(size/chunkSize) for non-empty inputs', () => {
    const size = 40000;
    const chunks = chunkBuffer(bytes(size));
    expect(chunks).toHaveLength(Math.ceil(size / DEFAULT_CHUNK_SIZE));
  });

  it('honors a custom chunk size and exact multiples', () => {
    const chunks = chunkBuffer(bytes(40), 10);
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(parseChunk(c).payload.byteLength).toBe(10);
  });

  it('rejects a chunkSize <= 0', () => {
    expect(() => chunkBuffer(bytes(10), 0)).toThrow();
  });

  it('parseChunk detects truncation / corruption', () => {
    const good = frameChunk(3, bytes(100));
    // Truncate the payload: declared length no longer matches.
    const truncated = good.slice(0, good.byteLength - 5);
    expect(() => parseChunk(truncated)).toThrow();
    // Frame shorter than the header.
    expect(() => parseChunk(new ArrayBuffer(4))).toThrow();
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
      for (const c of chunkBuffer(data)) r.push(c);
      expect(eq(r.finish(), data)).toBe(true);
    }
  });

  it('reassembles out-of-order chunks correctly', () => {
    const size = 40000;
    const data = bytes(size);
    const chunks = chunkBuffer(data);
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
    for (const c of chunkBuffer(data)) r.push(c);
    r.finish();
    expect(got).not.toBeNull();
    expect(eq(got!, data)).toBe(true);
  });

  it('throws on duplicate chunk seq', () => {
    const data = bytes(40000);
    const chunks = chunkBuffer(data);
    const r = createReceiver({ meta: meta(data.byteLength) });
    r.push(chunks[0]);
    expect(() => r.push(chunks[0])).toThrow(/duplicate/);
  });

  it('throws on a missing chunk (gap) at finish', () => {
    const data = bytes(40000);
    const chunks = chunkBuffer(data);
    const r = createReceiver({ meta: meta(data.byteLength) });
    // Skip the middle chunk.
    r.push(chunks[0]);
    r.push(chunks[2]);
    expect(() => r.finish()).toThrow(/missing/);
  });

  it('throws when reassembled size != offered size', () => {
    const data = bytes(16384);
    const r = createReceiver({ meta: meta(99999) });
    for (const c of chunkBuffer(data)) r.push(c);
    expect(() => r.finish()).toThrow(/size/);
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
    expect(drains).toBe(chunkBuffer(data).length);
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

    for (const c of chunkBuffer(data)) mgr.onChunk(c, meta.id);
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
});
