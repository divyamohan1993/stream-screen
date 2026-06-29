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
 * Each binary chunk is self-describing: it carries its OWN transfer id, sequence
 * number and payload length so that several concurrent transfers can share the
 * single binary `file` data channel without cross-contamination. The viewer file
 * picker allows selecting multiple files (multiple senders), so a second
 * `file-offer` can arrive before the first file's chunks have finished; routing
 * every binary frame by its embedded transfer id is what keeps the two streams
 * from corrupting each other.
 *
 * Binary frame layout (little-endian):
 *
 *   bytes 0..1            uint16  idLen        — length of the utf-8 transfer id
 *   bytes 2..2+idLen      utf8    idBytes      — the transfer id
 *   next  4 bytes         uint32  transferSeq  — chunk index within this transfer (0-based)
 *   next  4 bytes         uint32  payloadLen   — number of payload bytes that follow
 *   remaining             payload
 *
 * The framing does not depend on ordered delivery: the embedded seq lets the
 * receiver slot out-of-order frames, detect duplicates, and verify there are no
 * gaps at finish.
 */

import type { ControlMessage } from './protocol.js';

/** Default payload size per chunk (16 KiB) — safe for SCTP data channels. */
export const DEFAULT_CHUNK_SIZE = 16_384;

/** Size of the fixed portion of the binary frame header (seq u32 + payloadLen u32). */
export const CHUNK_HEADER_BYTES = 8;

/** Size of the transfer-id length prefix (uint16) that precedes the id bytes. */
export const CHUNK_ID_LEN_BYTES = 2;

/** Maximum encodable transfer-id length in bytes (uint16). */
const MAX_ID_BYTES = 0xffff;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Metadata describing a file to transfer. */
export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * Split `data` into framed binary chunks for transfer `id`, each prefixed with
 * the id + (transferSeq + payloadLen) header.
 *
 * A zero-length input yields exactly one empty-payload chunk (seq 0) so the
 * receiver still observes the transfer and can complete it.
 */
export function chunkBuffer(
  id: string,
  data: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE,
): ArrayBuffer[] {
  if (chunkSize <= 0) throw new RangeError('chunkBuffer: chunkSize must be > 0');
  const out: ArrayBuffer[] = [];
  const total = data.byteLength;
  let seq = 0;
  let offset = 0;
  do {
    const end = Math.min(offset + chunkSize, total);
    out.push(frameChunk(id, seq, data.subarray(offset, end)));
    seq += 1;
    offset = end;
  } while (offset < total);
  return out;
}

/** Build a single framed binary chunk from a transfer id, sequence number and payload. */
export function frameChunk(id: string, seq: number, payload: Uint8Array): ArrayBuffer {
  const idBytes = textEncoder.encode(id);
  if (idBytes.byteLength > MAX_ID_BYTES) {
    throw new RangeError(`frameChunk: transfer id too long (${idBytes.byteLength} > ${MAX_ID_BYTES})`);
  }
  const headerLen = CHUNK_ID_LEN_BYTES + idBytes.byteLength + CHUNK_HEADER_BYTES;
  const buf = new ArrayBuffer(headerLen + payload.byteLength);
  const view = new DataView(buf);
  view.setUint16(0, idBytes.byteLength, true);
  new Uint8Array(buf, CHUNK_ID_LEN_BYTES, idBytes.byteLength).set(idBytes);
  const seqOffset = CHUNK_ID_LEN_BYTES + idBytes.byteLength;
  view.setUint32(seqOffset, seq, true);
  view.setUint32(seqOffset + 4, payload.byteLength, true);
  new Uint8Array(buf, headerLen).set(payload);
  return buf;
}

/** A decoded chunk frame. */
export interface DecodedChunk {
  id: string;
  seq: number;
  len: number;
  payload: Uint8Array;
}

/**
 * Parse a framed binary chunk back into its transfer id, sequence number and
 * payload.
 *
 * @throws if the buffer is shorter than the header, the id length runs past the
 *   end of the buffer, or the declared payload length does not match the
 *   available bytes (corruption / truncation).
 */
export function parseChunk(buf: ArrayBuffer): DecodedChunk {
  if (buf.byteLength < CHUNK_ID_LEN_BYTES) {
    throw new RangeError('parseChunk: frame shorter than id-length prefix');
  }
  const view = new DataView(buf);
  const idLen = view.getUint16(0, true);
  const headerLen = CHUNK_ID_LEN_BYTES + idLen + CHUNK_HEADER_BYTES;
  if (buf.byteLength < headerLen) {
    throw new RangeError('parseChunk: frame shorter than header');
  }
  const id = textDecoder.decode(new Uint8Array(buf, CHUNK_ID_LEN_BYTES, idLen));
  const seqOffset = CHUNK_ID_LEN_BYTES + idLen;
  const seq = view.getUint32(seqOffset, true);
  const payloadLen = view.getUint32(seqOffset + 4, true);
  const available = buf.byteLength - headerLen;
  if (payloadLen !== available) {
    throw new RangeError(
      `parseChunk: declared payload ${payloadLen} != available ${available} (corrupt frame)`,
    );
  }
  return { id, seq, len: payloadLen, payload: new Uint8Array(buf.slice(headerLen)) };
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
  /** The transfer id (echoed in control messages and embedded in every chunk). */
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
 *
 * Every chunk is framed with `meta.id` so a receiver/router can demultiplex it
 * even when several transfers share one binary channel.
 */
export function createSender(opts: SenderOptions): FileSender {
  const { meta, data, send, sendChunk, onProgress, drain } = opts;
  const chunks = chunkBuffer(meta.id, data, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  // Cache per-chunk payload length so progress accounting does not need to know
  // the variable-length id header size.
  const payloadLens = computePayloadLens(data, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);

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
      for (let i = 0; i < chunks.length; i++) {
        if (drain) await drain();
        await sendChunk(chunks[i]);
        received += payloadLens[i];
        send({ t: 'file-progress', id: meta.id, received });
        onProgress?.(received, meta.size);
      }
      send({ t: 'file-complete', id: meta.id });
    },
  };
}

/** Compute the payload length of each chunk (mirrors {@link chunkBuffer} slicing). */
function computePayloadLens(data: Uint8Array, chunkSize: number): number[] {
  const lens: number[] = [];
  const total = data.byteLength;
  let offset = 0;
  do {
    const end = Math.min(offset + chunkSize, total);
    lens.push(end - offset);
    offset = end;
  } while (offset < total);
  return lens;
}

/** Hooks for a {@link createReceiver}. */
export interface FileReceiver {
  readonly meta: FileMeta;
  /**
   * Feed one framed binary chunk (from the `file` channel) into the receiver.
   * Frames whose embedded id does not match `meta.id` are rejected so a misrouted
   * chunk can never silently contaminate this transfer.
   */
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
 * number; duplicate sequences throw, frames belonging to another transfer id are
 * rejected, and {@link FileReceiver.finish} verifies there are no gaps and that
 * the total length matches the offered size.
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
      const { id, seq, payload } = parseChunk(buf);
      if (id !== meta.id) {
        throw new Error(
          `createReceiver: chunk id ${JSON.stringify(id)} != expected ${JSON.stringify(meta.id)}`,
        );
      }
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
 * Routes inbound binary chunks to the correct {@link FileReceiver} by their
 * embedded transfer id, supporting several concurrent transfers over one binary
 * `file` channel. Chunks whose id matches no registered receiver are dropped
 * (never misrouted).
 */
export class ReceiverRouter {
  private readonly receivers = new Map<string, FileReceiver>();

  /** Register a receiver for its transfer id. Replaces any prior one for that id. */
  register(id: string, receiver: FileReceiver): void {
    this.receivers.set(id, receiver);
  }

  /** Remove the receiver for `id` (e.g. on complete/reject/error). */
  unregister(id: string): void {
    this.receivers.delete(id);
  }

  /** Whether a receiver is registered for `id`. */
  has(id: string): boolean {
    return this.receivers.has(id);
  }

  /** Look up the receiver registered for `id`, if any. */
  get(id: string): FileReceiver | undefined {
    return this.receivers.get(id);
  }

  /**
   * Parse a binary frame and dispatch it to the receiver matching its embedded
   * id. Returns the receiver it was delivered to, or `undefined` if no receiver
   * is registered for that id (the chunk is dropped, not misrouted).
   */
  handleChunk(buf: ArrayBuffer): FileReceiver | undefined {
    const { id } = parseChunk(buf);
    const receiver = this.receivers.get(id);
    if (!receiver) return undefined;
    receiver.push(buf);
    return receiver;
  }
}

/**
 * A small stateful manager that multiplexes several concurrent receivers keyed
 * by transfer id, suitable for wiring directly to the control + file channels.
 *
 * Binary chunks are routed by their EMBEDDED transfer id via an internal
 * {@link ReceiverRouter}, so interleaved chunks from concurrent transfers cannot
 * cross-contaminate.
 *
 * Typical wiring:
 *   onControl(m => mgr.onControl(m))   // routes file-offer/complete
 *   onFileChunk(buf => mgr.onChunk(buf))
 */
export class FileTransferManager {
  private readonly router = new ReceiverRouter();

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
        this.router.register(
          m.id,
          createReceiver({ meta, onComplete: (d, mt) => this.onFileReady(d, mt) }),
        );
        if (this.autoAccept && this.sendControl) {
          this.sendControl({ t: 'file-accept', id: m.id });
        }
        break;
      }
      case 'file-complete': {
        const r = this.router.get(m.id);
        if (r) {
          try {
            r.finish();
          } finally {
            this.router.unregister(m.id);
          }
        }
        break;
      }
      case 'file-error':
      case 'file-reject': {
        this.router.unregister(m.id);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Feed a binary chunk; it is routed to the receiver matching the transfer id
   * embedded in the frame. Unknown-id chunks are dropped.
   */
  onChunk(buf: ArrayBuffer): void {
    this.router.handleChunk(buf);
  }

  /** Whether a transfer with `id` is currently being received. */
  has(id: string): boolean {
    return this.router.has(id);
  }
}
