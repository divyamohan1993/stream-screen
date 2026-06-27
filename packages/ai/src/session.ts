/**
 * RemoteDesktopSession — the shared control engine that both the MCP server and
 * the REST API drive. It owns a single viewer-side {@link Peer} connection to a
 * host and turns high-level tool calls (connect, screenshot, click, …) into
 * signaling + {@link InputEvent}s over the data channel.
 *
 * WebRTC runtime: a node WebRTC implementation is required to actually connect.
 * `@roamhq/wrtc` (preferred) and `werift` ship native/heavy bits and are
 * therefore OPTIONAL — loaded via dynamic `import()`. When none is available the
 * session stays valid but every connect/capture/control call rejects with a
 * clear "requires native webrtc runtime" error, and the MCP/REST surfaces remain
 * fully introspectable and testable. A runtime may also be injected directly
 * (for tests or alternative back-ends).
 *
 * Always free, no time limits: there are no session timers, usage counters, or
 * licensing checks anywhere in this class.
 */

import { deflateSync } from 'node:zlib';
import { Peer, SignalingClient, isValidSessionCode } from '@stream-screen/core';
import type {
  AdaptiveStats,
  ControlMessage,
  InputEvent,
  MonitorInfo,
  QualityPreset,
  SessionInfo,
} from '@stream-screen/core';
import {
  clickEvents,
  comboEvents,
  moveMouseEvent,
  pressKeyEvents,
  sendKeysEvents,
  toQualityPreset,
  typeTextEvents,
} from './tools.js';

/**
 * The minimal {@link Peer} surface this session drives. Declaring it as an
 * interface (rather than depending on the concrete class) lets tests inject a
 * lightweight fake peer that records the events/control messages it receives —
 * see {@link RemoteDesktopSession.attachTestPeer}.
 */
export interface SessionPeer {
  sendInput(e: InputEvent): void;
  sendControl(m: ControlMessage): void;
  onControl(cb: (m: ControlMessage) => void): void;
  getStats(): Promise<AdaptiveStats>;
  close(): void;
}

/** A discoverable host returned by {@link RemoteDesktopSession.listHosts}. */
export interface HostEntry {
  code: string;
  name: string;
}

/** Options for {@link RemoteDesktopSession}. */
export interface SessionOptions {
  /**
   * Signaling server URL, e.g. `ws://192.168.1.5:8787`. Defaults to
   * `STREAMSCREEN_SIGNALING_URL` or `ws://127.0.0.1:8787`.
   */
  signalingUrl?: string;
  /** STUN/TURN servers (LAN P2P usually needs none). */
  iceServers?: RTCIceServer[];
  /**
   * Injected `RTCPeerConnection` constructor. When omitted, the session tries to
   * load an optional node WebRTC library at connect time.
   */
  rtcPeerConnection?: typeof RTCPeerConnection;
  /** Name this viewer advertises to the host. */
  viewerName?: string;
}

/** A captured frame: raw encoded image bytes plus its declared MIME type. */
export interface CapturedFrame {
  data: Buffer;
  mimeType: string;
}

/** Thrown when no node WebRTC runtime is available to back the connection. */
export class WebRtcUnavailableError extends Error {
  constructor() {
    super(
      'This operation requires a native WebRTC runtime. Install the optional ' +
        'dependency "@roamhq/wrtc" (or provide opts.rtcPeerConnection) to enable ' +
        'remote desktop connections from this AI server.',
    );
    this.name = 'WebRtcUnavailableError';
  }
}

/** Thrown when a control/capture tool is used before {@link connect}. */
export class NotConnectedError extends Error {
  constructor() {
    super('Not connected: call connect({ code }) before using this tool.');
    this.name = 'NotConnectedError';
  }
}

const DEFAULT_SIGNALING_URL = 'ws://127.0.0.1:8787';

/**
 * Attempt to resolve a node WebRTC `RTCPeerConnection` constructor.
 * Tries `@roamhq/wrtc` then `werift`. Returns `null` if neither is installed.
 */
async function resolveNodeRtc(): Promise<typeof RTCPeerConnection | null> {
  // Prefer @roamhq/wrtc (drop-in DOM-compatible RTCPeerConnection).
  try {
    const mod = (await import('@roamhq/wrtc')) as {
      default?: { RTCPeerConnection?: typeof RTCPeerConnection };
      RTCPeerConnection?: typeof RTCPeerConnection;
    };
    const ctor = mod.RTCPeerConnection ?? mod.default?.RTCPeerConnection;
    if (typeof ctor === 'function') return ctor;
  } catch {
    /* not installed — try the next */
  }
  // Fall back to werift if present. The specifier is held in a variable so the
  // type-checker does not require `werift` to be installed (it is an optional,
  // un-declared runtime fallback resolved purely dynamically).
  try {
    const weriftSpecifier = 'werift';
    const mod = (await import(weriftSpecifier)) as {
      RTCPeerConnection?: typeof RTCPeerConnection;
    };
    if (typeof mod.RTCPeerConnection === 'function') return mod.RTCPeerConnection;
  } catch {
    /* not installed */
  }
  return null;
}

export class RemoteDesktopSession {
  private readonly opts: SessionOptions;
  private readonly signalingUrl: string;

  private signaling: SignalingClient | null = null;
  private peer: SessionPeer | null = null;
  private rtcCtor: typeof RTCPeerConnection | null;
  private connectedCode: string | null = null;

  /** Pending resolvers awaiting the host's `monitors` reply (list_monitors). */
  private monitorWaiters: Array<(list: MonitorInfo[]) => void> = [];
  /** Most recent monitor list reported by the host, if any. */
  private lastMonitors: MonitorInfo[] | null = null;

  /** Most recent decoded video frame, kept for screenshot/OCR. */
  private lastFrame: CapturedFrame | null = null;
  /** Frame sink installed on the inbound track, if the runtime supports it. */
  private frameSink: ((frame: CapturedFrame) => void) | null = null;

  constructor(opts: SessionOptions = {}) {
    this.opts = opts;
    this.signalingUrl =
      opts.signalingUrl ?? process.env.STREAMSCREEN_SIGNALING_URL ?? DEFAULT_SIGNALING_URL;
    this.rtcCtor = opts.rtcPeerConnection ?? null;
  }

  /** Whether a connection is currently established. */
  get connected(): boolean {
    return this.peer !== null && this.connectedCode !== null;
  }

  /** The session code we are connected to, if any. */
  get code(): string | null {
    return this.connectedCode;
  }

  /**
   * Browse the LAN for active host sessions via the signaling server's `hosts`
   * message. Returns immediately with whatever the server reports.
   */
  async listHosts(timeoutMs = 1500): Promise<HostEntry[]> {
    const client = new SignalingClient(this.signalingUrl);
    await client.connect();
    try {
      return await new Promise<HostEntry[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), timeoutMs);
        client.on('hosts', (m) => {
          clearTimeout(timer);
          const payload = (m.payload ?? []) as Array<SessionInfo | HostEntry>;
          resolve(
            payload.map((h) => ({
              code: (h as SessionInfo).code,
              name: (h as HostEntry).name ?? (h as SessionInfo).hostName ?? 'host',
            })),
          );
        });
        // Ask the server to enumerate hosts.
        client.send({ type: 'hosts' });
      });
    } finally {
      client.close();
    }
  }

  /**
   * Connect to a host by its session code as a viewer. Idempotent for the same
   * code; reconnecting to a different code disconnects first.
   */
  async connect(code: string): Promise<void> {
    if (!isValidSessionCode(code)) {
      throw new Error(`Invalid session code "${code}": expected 6–9 digits.`);
    }
    if (this.connected && this.connectedCode === code) return;
    if (this.connected) this.disconnect();

    const ctor = await this.ensureRtc();

    const signaling = new SignalingClient(this.signalingUrl);
    await signaling.connect();

    const peer = new Peer({
      role: 'viewer',
      signaling,
      iceServers: this.opts.iceServers,
      rtcPeerConnection: ctor,
    });

    peer.on('track', (track: unknown) => {
      this.installFrameSink(track);
    });
    peer.onControl((m) => this.handleControl(m));

    await peer.start();
    signaling.join({ code, role: 'viewer', name: this.opts.viewerName ?? 'streamscreen-ai' });

    this.signaling = signaling;
    this.peer = peer;
    this.connectedCode = code;
  }

  /** Disconnect from the current session. No-op if not connected. */
  disconnect(): void {
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    if (this.signaling) {
      this.signaling.close();
      this.signaling = null;
    }
    this.connectedCode = null;
    this.lastFrame = null;
    this.frameSink = null;
    this.lastMonitors = null;
    // Reject any list_monitors calls still awaiting a reply.
    const waiters = this.monitorWaiters;
    this.monitorWaiters = [];
    for (const w of waiters) w([]);
  }

  /**
   * Capture the latest remote frame as encoded image bytes (PNG). Requires an
   * active connection that has produced at least one frame.
   */
  async screenshot(): Promise<CapturedFrame> {
    this.assertConnected();
    if (!this.lastFrame) {
      throw new Error(
        'No frame captured yet: the remote video track has not delivered a frame. ' +
          'Wait briefly after connect() before taking a screenshot.',
      );
    }
    return this.lastFrame;
  }

  /** Move the remote cursor to a normalized (x,y) in [0,1]. */
  moveMouse(x: number, y: number): void {
    this.send(moveMouseEvent(x, y));
  }

  /** Click `button` (0=left,1=middle,2=right) at normalized (x,y). */
  click(x: number, y: number, button?: number): void {
    for (const e of clickEvents(x, y, button)) this.send(e);
  }

  /** Type a string on the remote machine. */
  typeText(text: string): void {
    for (const e of typeTextEvents(text)) this.send(e);
  }

  /** Press and release a key with optional modifier bitflags. */
  pressKey(key: string, mods?: number): void {
    for (const e of pressKeyEvents(key, mods)) this.send(e);
  }

  /** Fetch live connection-quality stats. */
  async getStats(): Promise<AdaptiveStats> {
    this.assertConnected();
    return this.peer!.getStats();
  }

  /**
   * Ask the host to enumerate its displays and return the reported list. Sends a
   * `request-monitors` control message and resolves when the host replies with a
   * `monitors` message (or after `timeoutMs`, with the last-known list or []).
   */
  async listMonitors(timeoutMs = 2000): Promise<MonitorInfo[]> {
    this.assertConnected();
    return await new Promise<MonitorInfo[]>((resolve) => {
      let settled = false;
      const done = (list: MonitorInfo[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(list);
      };
      const timer = setTimeout(() => {
        // Drop our waiter and resolve with whatever we last knew.
        this.monitorWaiters = this.monitorWaiters.filter((w) => w !== done);
        done(this.lastMonitors ?? []);
      }, timeoutMs);
      this.monitorWaiters.push(done);
      this.peer!.sendControl({ t: 'request-monitors' });
    });
  }

  /** Switch the active streamed monitor to `id` (from {@link listMonitors}). */
  switchMonitor(id: string): void {
    this.assertConnected();
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Missing or invalid monitor id.');
    }
    this.peer!.sendControl({ t: 'switch-monitor', id });
  }

  /** Send a chat message to the host operator. */
  sendChat(text: string): void {
    this.assertConnected();
    if (typeof text !== 'string') throw new Error('Missing or invalid chat text.');
    this.peer!.sendControl({ t: 'chat', text, ts: Date.now() });
  }

  /** Set the streaming quality preset (validated). */
  setQuality(preset: unknown): QualityPreset {
    this.assertConnected();
    const p = toQualityPreset(preset);
    this.peer!.sendControl({ t: 'quality', preset: p });
    return p;
  }

  /** Press an arbitrary modifier+key chord (e.g. ['ctrl','alt','delete']). */
  sendKeys(keys: unknown): void {
    for (const e of sendKeysEvents(keys)) this.send(e);
  }

  /** Press a named special combo (e.g. 'ctrl+alt+del'). */
  pressCombo(combo: unknown): void {
    for (const e of comboEvents(combo)) this.send(e);
  }

  /**
   * Inject a fake peer and mark the session connected. FOR TESTS ONLY: lets a
   * test exercise the real control/dispatch path (the `connected` guard plus
   * `peer.sendInput`/`peer.sendControl`) without a WebRTC runtime or signaling.
   */
  attachTestPeer(peer: SessionPeer, code = '123456'): void {
    this.peer = peer;
    this.connectedCode = code;
    peer.onControl((m) => this.handleControl(m));
  }

  /** Route an inbound control message (monitor replies, etc.). */
  private handleControl(m: ControlMessage): void {
    if (m.t === 'monitors') {
      this.lastMonitors = m.list;
      const waiters = this.monitorWaiters;
      this.monitorWaiters = [];
      for (const w of waiters) w(m.list);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private send(e: InputEvent): void {
    this.assertConnected();
    this.peer!.sendInput(e);
  }

  private assertConnected(): void {
    if (!this.connected) throw new NotConnectedError();
  }

  /** Resolve (and memoize) the RTCPeerConnection constructor. */
  private async ensureRtc(): Promise<typeof RTCPeerConnection> {
    if (this.rtcCtor) return this.rtcCtor;
    const resolved = await resolveNodeRtc();
    if (!resolved) throw new WebRtcUnavailableError();
    this.rtcCtor = resolved;
    return resolved;
  }

  /**
   * Wire a frame sink onto the inbound remote video track when the WebRTC
   * runtime supports raw frame access (`@roamhq/wrtc` exposes
   * `RTCVideoSink`). We pull I420 frames, but since image encoding (I420→PNG)
   * is runtime-specific we store the most recent raw frame's encoded form when a
   * sink already yields encoded data. If the runtime offers no sink, screenshots
   * remain unavailable until a frame arrives via an injected sink.
   */
  private installFrameSink(track: unknown): void {
    // Allow an externally-installed sink (e.g. injected in tests) to win.
    this.frameSink = (frame) => {
      this.lastFrame = frame;
    };
    // @roamhq/wrtc nonstandard: nonstandard.RTCVideoSink. We probe for it
    // lazily; if unavailable, frames must be provided via pushFrame().
    void this.tryNativeSink(track);
  }

  private async tryNativeSink(track: unknown): Promise<void> {
    try {
      const wrtc = (await import('@roamhq/wrtc')) as unknown as {
        nonstandard?: {
          RTCVideoSink?: new (t: unknown) => {
            onframe: ((e: { frame: { width: number; height: number; data: Uint8Array } }) => void) | null;
          };
        };
      };
      const Sink = wrtc.nonstandard?.RTCVideoSink;
      if (!Sink) return;
      const sink = new Sink(track);
      sink.onframe = (e) => {
        // Store the raw I420 frame wrapped as a CapturedFrame. Consumers that
        // need PNG should encode it; we expose the raw bytes with a precise
        // mime type so no information is lost.
        const png = encodeI420ToPng(e.frame);
        if (png) this.pushFrame({ data: png, mimeType: 'image/png' });
      };
    } catch {
      /* native sink unavailable; frames may be pushed externally */
    }
  }

  /**
   * Inject an already-encoded frame as the current screenshot source. Used by
   * tests and by alternative capture pipelines that decode video out-of-band.
   */
  pushFrame(frame: CapturedFrame): void {
    if (this.frameSink) this.frameSink(frame);
    else this.lastFrame = frame;
  }
}

/**
 * Encode a raw I420 video frame to a PNG buffer. We perform the YUV→RGB
 * conversion ourselves and emit a minimal (uncompressed-IDAT) PNG so this needs
 * no native image library. Returns `null` if the frame is malformed.
 */
function encodeI420ToPng(frame: {
  width: number;
  height: number;
  data: Uint8Array;
}): Buffer | null {
  const { width, height, data } = frame;
  if (width <= 0 || height <= 0) return null;
  const ySize = width * height;
  const cSize = (width >> 1) * (height >> 1);
  if (data.length < ySize + 2 * cSize) return null;

  const uOff = ySize;
  const vOff = ySize + cSize;
  const cw = width >> 1;

  // RGBA raster with a leading filter byte per scanline (PNG filter type 0).
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let j = 0; j < height; j++) {
    raw[j * stride] = 0; // filter: none
    const cj = j >> 1;
    for (let i = 0; i < width; i++) {
      const ci = i >> 1;
      const Y = data[j * width + i];
      const U = data[uOff + cj * cw + ci] - 128;
      const V = data[vOff + cj * cw + ci] - 128;
      const r = clampByte(Y + 1.402 * V);
      const g = clampByte(Y - 0.344136 * U - 0.714136 * V);
      const b = clampByte(Y + 1.772 * U);
      const p = j * stride + 1 + i * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  return buildPng(width, height, raw);
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

/** Build a PNG from a filtered RGBA raster using zlib deflate. */
function buildPng(width: number, height: number, filtered: Buffer): Buffer {
  const idat = deflateSync(filtered);

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** Standard CRC-32 (PNG polynomial). */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
