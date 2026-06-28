import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ControlMessage,
  InputEvent,
  AdaptiveStats,
  VerifierRecord,
  FileMeta,
} from '@stream-screen/core';

/**
 * P2 (viewer defensive side): inbound host file pushes must NOT be auto-accepted
 * or processed while the session is GATED — i.e. the host required authorization
 * (an `auth-challenge` arrived) and we have not yet received `auth-result{ok:true}`.
 *
 * In a protected mode the control/file channels are open during the auth
 * handshake, so a malicious/buggy host could push a `file-offer` (plus chunks)
 * before the verdict. The viewer used to AUTO-ACCEPT every inbound offer, which
 * would let a file reach an unauthorized viewer. These tests assert that:
 *   - an offer arriving BEFORE `auth-result{ok:true}` is dropped (no `file-accept`,
 *     no UI surfacing, chunks discarded, file never assembled);
 *   - once authorized, a subsequent offer is handled normally (accepted + assembled).
 *
 * Only `Peer`/`SignalingClient` are faked; the real core `FileTransferManager`
 * and crypto helpers are used.
 */

type StateCb = (s: RTCPeerConnectionState) => void;
type TrackCb = (track: MediaStreamTrack, stream: MediaStream) => void;

function channelBinding(): string {
  return 'sha-256 AA:BB|sha-256 CC:DD';
}
const CHANNEL_BINDING = channelBinding();

class FakePeer {
  static current: FakePeer | null = null;
  controlCb: ((m: ControlMessage) => void) | null = null;
  chunkCb: ((b: ArrayBuffer) => void) | null = null;
  stateCb: StateCb | null = null;
  trackCb: TrackCb | null = null;
  sentControl: ControlMessage[] = [];

  constructor() {
    FakePeer.current = this;
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'state') this.stateCb = cb as StateCb;
    if (ev === 'track') this.trackCb = cb as TrackCb;
  }
  async start(): Promise<void> {}
  async getStats(): Promise<AdaptiveStats> {
    return {
      rttMs: 0,
      lossPct: 0,
      jitterMs: 0,
      availableKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
      playoutMs: 0,
      ts: Date.now(),
    };
  }
  sendControl(m: ControlMessage): void {
    this.sentControl.push(m);
  }
  onControl(cb: (m: ControlMessage) => void): void {
    this.controlCb = cb;
  }
  onFileChunk(cb: (b: ArrayBuffer) => void): void {
    this.chunkCb = cb;
  }
  onInput(_cb: (e: InputEvent) => void): void {}
  sendInput(): void {}
  sendFileChunk(): void {}
  getFileBufferedAmount(): number {
    return 0;
  }
  async drainFile(): Promise<void> {}
  getChannelBinding(): string {
    return channelBinding();
  }
  close(): void {}

  goConnected(): void {
    this.stateCb?.('connected');
  }
  deliver(m: ControlMessage): void {
    this.controlCb?.(m);
  }
  deliverChunk(b: ArrayBuffer): void {
    this.chunkCb?.(b);
  }
}

class FakeSignaling {
  private handlers = new Map<string, (m: unknown) => void>();
  on(ev: string, cb: (m: unknown) => void): void {
    this.handlers.set(ev, cb);
  }
  off(): void {}
  async connect(): Promise<void> {}
  join(): void {
    this.handlers.get('joined')?.({ type: 'joined' });
  }
  close(): void {}
}

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: FakeSignaling };
});

const { ViewerSession } = await import('./viewer-session.js');
const { makeVerifier, toBase64, randomBytes, NONCE_BYTES, frameChunk } = await import(
  '@stream-screen/core'
);
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;

const PIN = '824193';

function challengeFor(
  verifier: VerifierRecord,
  mode: 'pin' | 'pin-and-prompt' | 'prompt',
  nonceH: Uint8Array,
): Extract<ControlMessage, { t: 'auth-challenge' }> {
  return {
    t: 'auth-challenge',
    v: 1,
    nonceH: toBase64(nonceH),
    salt: verifier.salt,
    iterations: verifier.iterations,
    channelBinding: CHANNEL_BINDING,
    mode,
  };
}

async function connectedSession(handlers: Handlers = {}) {
  const session = new ViewerSession({
    code: '123456',
    signalingUrl: 'ws://x:8787',
    name: 'tester',
    handlers,
  });
  await session.connect();
  FakePeer.current!.goConnected();
  return session;
}

describe('ViewerSession inbound file auth-gate (P2 defensive viewer side)', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('open mode: inbound file offers are accepted + assembled as today (no gate)', async () => {
    const ready = new Map<string, Uint8Array>();
    await connectedSession({ onFileReady: (data, meta) => ready.set(meta.id, data) });
    const peer = FakePeer.current!;

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const meta: FileMeta = { id: 'OPEN', name: 'o.bin', size: bytes.byteLength, mime: '' };
    peer.deliver({ t: 'file-offer', ...meta });
    expect(peer.sentControl).toContainEqual({ t: 'file-accept', id: 'OPEN' });

    peer.deliverChunk(frameChunk('OPEN', 0, bytes));
    peer.deliver({ t: 'file-complete', id: 'OPEN' });
    expect(ready.get('OPEN')).toEqual(bytes);
  });

  it('GATED: an inbound file-offer before auth-result ok is NOT accepted/surfaced/assembled', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);
    const ready = new Map<string, Uint8Array>();
    const transfers: unknown[] = [];
    const session = await connectedSession({
      onFileReady: (data, meta) => ready.set(meta.id, data),
      onFileTransfer: (t) => transfers.push(t),
    });
    const peer = FakePeer.current!;

    // Host requires auth; the session is now gated.
    peer.deliver(challengeFor(verifier, 'pin', nonceH));
    expect(session.currentState).toBe('authenticating');

    // Host pushes a file BEFORE the viewer is authorized. It must be refused:
    // no auto-accept, no UI surfacing, chunks discarded, never assembled.
    const evil = new Uint8Array([9, 9, 9, 9]);
    peer.deliver({ t: 'file-offer', id: 'EVIL', name: 'evil.bin', size: evil.byteLength, mime: '' });
    peer.deliverChunk(frameChunk('EVIL', 0, evil));
    peer.deliver({ t: 'file-progress', id: 'EVIL', received: evil.byteLength });
    peer.deliver({ t: 'file-complete', id: 'EVIL' });

    expect(peer.sentControl.find((m) => m.t === 'file-accept')).toBeUndefined();
    expect(transfers).toEqual([]);
    expect(ready.has('EVIL')).toBe(false);
  });

  it('after auth-result ok: a subsequent inbound file-offer is accepted + assembled', async () => {
    const verifier = await makeVerifier(PIN, 1000);
    const nonceH = randomBytes(NONCE_BYTES);
    const ready = new Map<string, Uint8Array>();
    const transfers: unknown[] = [];
    const session = await connectedSession({
      onFileReady: (data, meta) => ready.set(meta.id, data),
      onFileTransfer: (t) => transfers.push(t),
    });
    const peer = FakePeer.current!;

    peer.deliver(challengeFor(verifier, 'pin', nonceH));
    await session.submitPin(PIN);

    // A pre-authorization offer is still gated/dropped.
    peer.deliver({ t: 'file-offer', id: 'PRE', name: 'pre.bin', size: 1, mime: '' });
    expect(peer.sentControl.find((m) => m.t === 'file-accept' && m.id === 'PRE')).toBeUndefined();

    // Host authorizes.
    peer.deliver({ t: 'auth-result', v: 1, ok: true });
    expect(session.currentState).toBe('connected');

    // Now inbound files flow normally.
    const good = new Uint8Array([7, 8, 9]);
    peer.deliver({ t: 'file-offer', id: 'GOOD', name: 'good.bin', size: good.byteLength, mime: '' });
    expect(peer.sentControl).toContainEqual({ t: 'file-accept', id: 'GOOD' });

    peer.deliverChunk(frameChunk('GOOD', 0, good));
    peer.deliver({ t: 'file-complete', id: 'GOOD' });
    expect(ready.get('GOOD')).toEqual(good);
    expect(transfers.length).toBeGreaterThan(0);
  });
});
