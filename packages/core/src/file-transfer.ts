/**
 * Transport-agnostic chunked file transfer for StreamScreen.
 *
 * This module is pure and DOM-free: it operates on `Uint8Array`/`ArrayBuffer`
 * and a pair of injected send functions, so it round-trips identically in node
 * (tests) and the browser. The two halves work together with the control-channel
 * {@link ControlMessage} offer/accept/progress/complete handshake:
 *
 *   sender:  send {file-offer} ──► receiver
 *            (await {file-accept})
 *            send binary chunks  ──► receiver  (over the BINARY `file` channel)
 *            send {file-complete} ──► receiver
 *
 * Each binary chunk is self-describing via a fixed 8-byte little-endian header
 * so chunks can be reassembled deterministically and out-of-order delivery is
 * detected (the `file` channel is reliable+ordered in practice, but the framing
 * does not depend on that and validates ordering defensively):
 *
 *   bytes 0..3  uint32  transferSeq  — chunk index within this transfer (0-based)
 *   bytes 4..7  uint32  payloadLen   — number of payload bytes that follow
 *   bytes 8..   payload
 *
 * A single `file` data channel can therefore be shared, but in practice one
 * transfer is in flight at a time per direction; the seq guards correctness.
 */

import type { ControlMessage } from './protocol.js';

/** Default payload size per chunk (16 KiB) — safe for SCTP data channels. */
export const DEFAULT_CHUNK_SIZE = 16_384;

/** Fixed binary frame header size in bytes (transferSeq u32 + payloadLen u32). */
export const CHUNK_HEADER_BYTES = 8;

/** Metadata describing a file to transfer. */
export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * Split `data` into framed binary chunks, each prefixed with an
 * {@link CHUNK_HEADER_BYTES}-byte header (transferSeq + payloadLen).
 *
 * A zero-length input yields exactly one empty-payload chunk (seq 0) so the
 * receiver still observes the transfer and can complete it.
 */
export function chunkBuffer(data: Uint8Array, chunkSize = DEFAULT_CHUNK_SIZE): ArrayBuffer[] {
  if (chunkSize <= 0) throw new RangeError('chunkBuffer: chunkSize must be > 0');
  const out: ArrayBuffer[] = [];
  const total = data.byteLength;
  let seq = 0;
  let offset = 0;
  do {
    const end = Math.min(offset + chunkSize, total);
    const payloadLen = end - offset;
    out.push(frameChunk(seq, data.subarray(offset, end)));
    seq += 1;
    offset = end;
  } while (offset < total);
  return out;
}

/** Build a single framed binary chunk from a sequence number and payload. */
export function frameChunk(seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, seq, true);
  view.setUint32(4, payload.byteLength, true);
  new Uint8Array(buf, CHUNK_HEADER_BYTES).set(payload);
  return buf;
}

/** A decoded chunk frame. */
export interface DecodedChunk {
  seq: number;
  payload: Uint8Array;
}

/**
 * Parse a framed binary chunk back into its sequence number and payload.
 *
 * @throws if the buffer is shorter than the header or the declared payload
 *   length does not match the available bytes (corruption / truncation).
 */
export function parseChunk(buf: ArrayBuffer): DecodedChunk {
  if (buf.byteLength < CHUNK_HEADER_BYTES) {
    throw new RangeError('parseChunk: frame shorter than header');
  }
  const view = new DataView(buf);
  const seq = view.getUint32(0, true);
  const payloadLen = view.getUint32(4, true);
  const available = buf.byteLength - CHUNK_HEADER_BYTES;
  if (payloadLen !== available) {
    throw new RangeError(
      `parseChunk: declared payload ${payloadLen} != available ${available} (corrupt frame)`,
    );
  }
  return { seq, payload: new Uint8Array(buf.slice(CHUNK_HEADER_BYTES)) };
}

/** Concatenate ordered payloads into one contiguous buffer. */
function concat(parts: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Hooks for a {@link createSender}. */
export interface FileSender {
  /** The transfer id (echoed in control messages). */
  readonly id: string;
  /**
   * Drive the transfer: emits the `file-offer` control message immediately, then
   * (once you signal acceptance via {@link accept}) streams the binary chunks and
   * emits `file-complete`. Resolves when all chunks have been handed to
   * `sendChunk`. Reports byte progress via `onProgress`.
   */
  start(): Promise<void>;
  /** Call when the matching `file-accept` arrives to release the chunk stream. */
  accept(): void;
  /** Call when a `file-reject`/`file-error` arrives to abort. */
  abort(reason?: string): void;
}

/** Options for {@link createSender}. */
export interface SenderOptions {
  meta: FileMeta;
  data: Uint8Array;
  /** Send a control message (the offer/complete frames). */
  send: (m: ControlMessage) => void;
  /** Send one framed binary chunk over the `file` channel. */
  sendChunk: (buf: ArrayBuffer) => void | Promise<void>;
  chunkSize?: number;
  /** Optional progress callback (bytes handed to `sendChunk` so far). */
  onProgress?: (received: number, total: number) => void;
  /**
   * Optional backpressure gate: awaited before each chunk send so callers can
   * wait on `RTCDataChannel.bufferedAmountLow`. Resolve to continue.
   */
  drain?: () => void | Promise<void>;
}

/**
 * Create a file sender. It sends the `file-offer` immediately on {@link FileSender.start},
 * then waits for {@link FileSender.accept} (driven by an inbound `file-accept`
 * control message) before streaming chunks and finishing with `file-complete`.
 */
export function createSender(opts: SenderOptions): FileSender {
  const { meta, data, send, sendChunk, onProgress, drain } = opts;
  const chunks = chunkBuffer(data, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);

  let acceptResolve: (() => void) | null = null;
  let acceptReject: ((e: Error) => void) | null = null;
  const accepted = new Promise<void>((resolve, reject) => {
    acceptResolve = resolve;
    acceptReject = reject;
  });

  return {
    id: meta.id,
    accept(): void {
      acceptResolve?.();
    },
    abort(reason?: string): void {
      acceptReject?.(new Error(reason ?? 'file transfer aborted'));
    },
    async start(): Promise<void> {
      send({ t: 'file-offer', id: meta.id, name: meta.name, size: meta.size, mime: meta.mime });
      await accepted;
      let received = 0;
      for (const chunk of chunks) {
        if (drain) await drain();
        await sendChunk(chunk);
        // payload length = frame length minus header.
        received += chunk.byteLength - CHUNK_HEADER_BYTES;
        send({ t: 'file-progress', id: meta.id, received });
        onProgress?.(received, meta.size);
      }
      send({ t: 'file-complete', id: meta.id });
    },
  };
}

/** Hooks for a {@link createReceiver}. */
export interface FileReceiver {
  readonly meta: FileMeta;
  /** Feed one framed binary chunk (from the `file` channel) into the receiver. */
  push(buf: ArrayBuffer): void;
  /** Bytes received so far. */
  readonly received: number;
  /** Finalize: validates completeness and returns the reassembled bytes. */
  finish(): Uint8Array;
}

/** Options for {@link createReceiver}. */
export interface ReceiverOptions {
  meta: FileMeta;
  /** Called once with the fully reassembled file when {@link FileReceiver.finish} succeeds. */
  onComplete?: (data: Uint8Array, meta: FileMeta) => void;
  /** Optional progress callback (bytes received so far). */
  onProgress?: (received: number, total: number) => void;
}

/**
 * Create a file receiver that reassembles framed chunks (in any arrival order)
 * into the original file. Out-of-order frames are slotted by their sequence
 * number; duplicate sequences throw, and {@link FileReceiver.finish} verifies
 * there are no gaps and that the total length matches the offered size.
 */
export function createReceiver(opts: ReceiverOptions): FileReceiver {
  const { meta, onComplete, onProgress } = opts;
  const slots = new Map<number, Uint8Array>();
  let received = 0;

  const receiver: FileReceiver = {
    meta,
    get received() {
      return received;
    },
    push(buf: ArrayBuffer): void {
      const { seq, payload } = parseChunk(buf);
      if (slots.has(seq)) {
        throw new Error(`createReceiver: duplicate chunk seq ${seq}`);
      }
      slots.set(seq, payload);
      received += payload.byteLength;
      onProgress?.(received, meta.size);
    },
    finish(): Uint8Array {
      const count = slots.size;
      const ordered: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        const part = slots.get(i);
        if (part === undefined) {
          throw new Error(`createReceiver: missing chunk seq ${i} (have ${count} chunks)`);
        }
        ordered.push(part);
      }
      const data = concat(ordered, received);
      if (data.byteLength !== meta.size) {
        throw new Error(
          `createReceiver: reassembled size ${data.byteLength} != offered ${meta.size}`,
        );
      }
      onComplete?.(data, meta);
      return data;
    },
  };
  return receiver;
}

/**
 * A small stateful manager that multiplexes several concurrent receivers keyed
 * by transfer id, suitable for wiring directly to the control + file channels.
 *
 * Typical wiring:
 *   onControl(m => mgr.onControl(m))   // routes file-offer/complete
 *   onFileChunk(buf => mgr.onChunk(activeId, buf))
 */
export class FileTransferManager {
  private readonly receivers = new Map<string, FileReceiver>();
  /** seq-ordering is per-transfer; we track the id of the most recent offer. */
  private lastOfferId: string | null = null;

  /**
   * @param onFileReady called when a transfer completes with its bytes + meta.
   * @param autoAccept  optional: send a `file-accept` for every offer.
   */
  constructor(
    private readonly onFileReady: (data: Uint8Array, meta: FileMeta) => void,
    private readonly sendControl?: (m: ControlMessage) => void,
    private readonly autoAccept = false,
  ) {}

  /** Handle a control message relevant to file transfer; ignores the rest. */
  onControl(m: ControlMessage): void {
    switch (m.t) {
      case 'file-offer': {
        const meta: FileMeta = { id: m.id, name: m.name, size: m.size, mime: m.mime };
        this.receivers.set(
          m.id,
          createReceiver({ meta, onComplete: (d, mt) => this.onFileReady(d, mt) }),
        );
        this.lastOfferId = m.id;
        if (this.autoAccept && this.sendControl) {
          this.sendControl({ t: 'file-accept', id: m.id });
        }
        break;
      }
      case 'file-complete': {
        const r = this.receivers.get(m.id);
        if (r) {
          try {
            r.finish();
          } finally {
            this.receivers.delete(m.id);
          }
        }
        break;
      }
      case 'file-error':
      case 'file-reject': {
        this.receivers.delete(m.id);
        break;
      }
      default:
        break;
    }
  }

  /** Feed a binary chunk into the receiver for `id` (defaults to the last offer). */
  onChunk(buf: ArrayBuffer, id: string | null = this.lastOfferId): void {
    const target = id ?? this.lastOfferId;
    if (target === null) return;
    this.receivers.get(target)?.push(buf);
  }

  /** Whether a transfer with `id` is currently being received. */
  has(id: string): boolean {
    return this.receivers.has(id);
  }
}
