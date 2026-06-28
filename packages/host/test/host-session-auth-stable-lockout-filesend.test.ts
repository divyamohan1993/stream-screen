/**
 * Security follow-ups for the host access/file feature:
 *
 *   P1 — STABLE PIN-LOCKOUT KEY. Failed PIN proofs were recorded under
 *   { ip: channelBinding, peerId: viewerId } — BOTH per-connection (a fresh peer
 *   UUID per join, a fresh DTLS binding per RTCPeerConnection). An attacker could
 *   disconnect + rejoin after each wrong guess to mint a brand-new lockout key
 *   and NEVER reach the threshold. The lockout must instead be keyed on the
 *   viewer's STABLE socket source address (the host-only SignalMessage.sourceAddr
 *   on 'peer-joined'), so failures from the same source keep accumulating across
 *   reconnects even though the viewer id + channel binding change each time.
 *
 *   P2 — FILE SEND AUTHORIZATION. In protected modes sendFile() WITHOUT a viewerId
 *   left the target undefined and BROADCAST the offer + chunks to every Peer
 *   connection — including unapproved viewers (whose control/file channels are
 *   open and which auto-accept inbound offers before an auth result). A no-target
 *   host send must reach ONLY currently-authorized viewers. Open mode still
 *   broadcasts to all (unchanged).
 *
 * The Peer / SignalingClient / FileTransferManager are faked (no Electron, no
 * WebRTC, no native deps) but the REAL crypto-auth + AuthVerifier + LockoutTracker
 * drive the decisions. A tiny KDF iteration count keeps PBKDF2 fast.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ControlMessage, FileMeta, InputEvent } from '@stream-screen/core';

// ---------------------------------------------------------------------------
// Fakes. The FakePeer captures the host's onControl/onControlOpen handlers,
// records sendControl + outbound file frames PER TARGET, and lets the test fire
// channel-open. The FakeSignalingClient lets the test fire 'peer-joined' (with an
// optional sourceAddr) and 'peer-left'.
// ---------------------------------------------------------------------------

interface SentControl {
  msg: ControlMessage;
  to?: string;
}

/** A recorded outbound file frame (control offer or a raw chunk) and its target. */
interface SentFileFrame {
  kind: 'offer' | 'chunk';
  to?: string;
}

const peerBus: {
  controlHandlers: ((m: ControlMessage, viewerId: string) => void)[];
  controlOpenHandlers: ((remoteId: string) => void)[];
  openViewers: Set<string>;
  sent: SentControl[];
  /** Every file-offer (control) + chunk send, tagged with its target. */
  fileFrames: SentFileFrame[];
  attachedTo: string[];
  /** Per-viewer channel binding; defaults to a fresh value each connection. */
  bindingFor: Map<string, string>;
  bindingSeq: number;
} = {
  controlHandlers: [],
  controlOpenHandlers: [],
  openViewers: new Set(),
  sent: [],
  fileFrames: [],
  attachedTo: [],
  bindingFor: new Map(),
  bindingSeq: 0,
};

let signalingBus: {
  emit: (type: string, msg: Record<string, unknown>) => void;
} | null = null;

vi.mock('@stream-screen/core', async () => {
  const actual = await vi.importActual<typeof import('@stream-screen/core')>(
    '@stream-screen/core',
  );

  class FakePeer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(_cb: (e: InputEvent, viewerId: string) => void): void {}
    on(): void {}
    onFileChunk(): void {}
    onControl(cb: (m: ControlMessage, viewerId: string) => void): () => void {
      peerBus.controlHandlers.push(cb);
      return () => {
        peerBus.controlHandlers = peerBus.controlHandlers.filter((h) => h !== cb);
      };
    }
    async start(): Promise<void> {}
    attachStream(): void {}
    async attachStreamTo(remoteId: string): Promise<void> {
      peerBus.attachedTo.push(remoteId);
    }
    onControlOpen(cb: (remoteId: string) => void): () => void {
      peerBus.controlOpenHandlers.push(cb);
      for (const id of peerBus.openViewers) cb(id);
      return () => {
        peerBus.controlOpenHandlers = peerBus.controlOpenHandlers.filter((h) => h !== cb);
      };
    }
    isControlOpen(remoteId: string): boolean {
      return peerBus.openViewers.has(remoteId);
    }
    async replaceVideoTrack(): Promise<boolean> {
      return true;
    }
    sendControl(msg: ControlMessage, to?: string): void {
      peerBus.sent.push({ msg, to });
      if (msg.t === 'file-offer') peerBus.fileFrames.push({ kind: 'offer', to });
    }
    sendFileChunk(_buf: ArrayBuffer, to?: string): void {
      peerBus.fileFrames.push({ kind: 'chunk', to });
    }
    drainFile(): void {}
    getChannelBinding(viewerId: string): string {
      // Mint a DISTINCT binding per connection: a NEW one is assigned the first
      // time a given viewerId is seen. This models the real world where every
      // RTCPeerConnection has its own DTLS binding (and the per-connection
      // viewerId differs too), so the lockout cannot be keyed on either.
      let b = peerBus.bindingFor.get(viewerId);
      if (!b) {
        b = `binding-${peerBus.bindingSeq++}`;
        peerBus.bindingFor.set(viewerId, b);
      }
      return b;
    }
    async getStats(): Promise<Record<string, number>> {
      return { rttMs: 20, lossPct: 0, jitterMs: 2, fps: 60, width: 1920, height: 1080, availableKbps: 0, playoutMs: 0 };
    }
    async applyDecision(): Promise<void> {}
    close(): void {}
  }

  class FakeSignalingClient {
    private handlers = new Map<string, Set<(m: Record<string, unknown>) => void>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string) {
      signalingBus = {
        emit: (type, msg) => {
          for (const cb of this.handlers.get(type) ?? []) cb(msg);
        },
      };
    }
    async connect(): Promise<void> {}
    on(type: string, cb: (m: Record<string, unknown>) => void): void {
      let s = this.handlers.get(type);
      if (!s) {
        s = new Set();
        this.handlers.set(type, s);
      }
      s.add(cb);
    }
    off(type: string, cb: (m: Record<string, unknown>) => void): void {
      this.handlers.get(type)?.delete(cb);
    }
    join(): void {
      for (const cb of this.handlers.get('joined') ?? []) cb({ type: 'joined' });
    }
    close(): void {}
  }

  class FakeFileTransferManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    onChunk(): void {}
    onControl(): void {}
  }

  class FakeMediaStream {
    getTracks(): unknown[] {
      return [];
    }
    getVideoTracks(): unknown[] {
      return [];
    }
    getAudioTracks(): unknown[] {
      return [];
    }
  }

  // A REAL-shaped sender: on start() it emits the offer (control) AND streams a
  // single chunk, both via the target-aware Peer (so they land in
  // peerBus.fileFrames tagged with the correct target), then resolves. This makes
  // a no-accept send deterministic: the test only needs to observe WHERE the
  // offer + chunk went, which is exactly what the P2 authorization gate controls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createSender = (opts: any) => {
    return {
      id: opts.meta.id,
      accept(): void {},
      abort(): void {},
      async start(): Promise<void> {
        opts.send({ t: 'file-offer', id: opts.meta.id, meta: opts.meta });
        await Promise.resolve(opts.sendChunk(new ArrayBuffer(opts.data.byteLength)));
        if (opts.onProgress) opts.onProgress(opts.data.byteLength, opts.data.byteLength);
      },
    };
  };

  return {
    ...actual,
    Peer: FakePeer,
    SignalingClient: FakeSignalingClient,
    isIceServerList: (v: unknown): boolean =>
      Array.isArray(v) &&
      v.every(
        (s) =>
          s !== null &&
          typeof s === 'object' &&
          (typeof (s as { urls?: unknown }).urls === 'string' ||
            (Array.isArray((s as { urls?: unknown }).urls) &&
              ((s as { urls: unknown[] }).urls).every((u) => typeof u === 'string'))),
      ),
    FileTransferManager: FakeFileTransferManager,
    createSender,
    __FakeMediaStream: FakeMediaStream,
  };
});

import { HostSession } from '../src/host-session.js';
import { LockoutTracker } from '../src/lockout-tracker.js';
import type { AccessMode } from '../src/access-config.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (): unknown };

const ITERS = 100;
const PIN = 'goodpin99';

function resetBus(): void {
  peerBus.controlHandlers = [];
  peerBus.controlOpenHandlers = [];
  peerBus.openViewers = new Set();
  peerBus.sent = [];
  peerBus.fileFrames = [];
  peerBus.attachedTo = [];
  peerBus.bindingFor = new Map();
  peerBus.bindingSeq = 0;
  signalingBus = null;
}

interface StartOpts {
  mode: AccessMode;
  lockout?: LockoutTracker;
}

async function startSession(opts: StartOpts): Promise<HostSession> {
  resetBus();
  const verifier =
    opts.mode === 'pin' || opts.mode === 'pin-and-prompt'
      ? await core.makeVerifier(PIN, ITERS)
      : null;
  const session = new HostSession({
    signalingUrl: 'ws://test',
    code: '123456',
    hostName: 'test-host',
    sourceId: 'screen:0',
    accessMode: opts.mode,
    verifier,
    lockout: opts.lockout,
    onInput: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: async () => new FakeMediaStream() as any,
  });
  await session.start();
  return session;
}

/** Fire a viewer joining the room (optionally with a stable sourceAddr), then open its control channel. */
function viewerJoins(viewerId: string, sourceAddr?: string, name?: string): void {
  signalingBus!.emit('peer-joined', {
    type: 'peer-joined',
    role: 'viewer',
    from: viewerId,
    name,
    sourceAddr,
  });
  openControl(viewerId);
}

function viewerLeaves(viewerId: string): void {
  peerBus.openViewers.delete(viewerId);
  signalingBus!.emit('peer-left', { type: 'peer-left', role: 'viewer', from: viewerId });
}

function openControl(viewerId: string): void {
  if (peerBus.openViewers.has(viewerId)) return;
  peerBus.openViewers.add(viewerId);
  for (const cb of [...peerBus.controlOpenHandlers]) cb(viewerId);
}

function deliverControl(m: ControlMessage, viewerId: string): void {
  for (const h of [...peerBus.controlHandlers]) h(m, viewerId);
}

/** Build a viewer auth-response for that viewer's last-issued challenge. */
async function buildResponse(viewerId: string, pin: string): Promise<ControlMessage> {
  const challenge = peerBus.sent
    .filter((s) => s.to === viewerId && s.msg.t === 'auth-challenge')
    .map((s) => s.msg)
    .pop() as Extract<ControlMessage, { t: 'auth-challenge' }>;
  expect(challenge).toBeTruthy();
  const salt = core.fromBase64(challenge.salt);
  const nonceH = core.fromBase64(challenge.nonceH);
  const nonceV = core.randomBytes(core.NONCE_BYTES);
  const key = await core.deriveKey(pin, salt, challenge.iterations);
  const proof = await core.computeProof(key, {
    domain: core.AUTH_DOMAIN,
    nonceH,
    nonceV,
    channelBinding: challenge.channelBinding,
  });
  return {
    t: 'auth-response',
    v: 1,
    nonceV: core.toBase64(nonceV),
    proof: core.toBase64(proof),
  };
}

const authResults = (viewerId: string): boolean[] =>
  peerBus.sent
    .filter((s) => s.to === viewerId && s.msg.t === 'auth-result')
    .map((s) => (s.msg as Extract<ControlMessage, { t: 'auth-result' }>).ok);

/** Authorize a viewer by feeding the correct PIN; resolves when authorized. */
async function authorize(session: HostSession, viewerId: string): Promise<void> {
  const resp = await buildResponse(viewerId, PIN);
  deliverControl(resp, viewerId);
  await vi.waitFor(() => expect(session.isAuthorized(viewerId)).toBe(true));
}

// ===========================================================================
// P1 — stable lockout key keyed on sourceAddr survives reconnects.
// ===========================================================================
describe('P1: PIN lockout is keyed on the STABLE source address across reconnects', () => {
  it('failures from the same sourceAddr accumulate to the threshold across rejoins (fresh viewerId/binding never resets)', async () => {
    let now = 0;
    // threshold 3 so the test issues exactly 3 failures across 3 separate
    // connections (each a different viewerId AND channel binding).
    const lockout = new LockoutTracker({ threshold: 3, baseMs: 1000, now: () => now });
    const session = await startSession({ mode: 'pin', lockout });

    const SRC = '203.0.113.7'; // the attacker's STABLE socket address
    const KEY = { ip: SRC, peerId: SRC };

    // --- Attempt 1: connection "v1" ---
    viewerJoins('v1', SRC);
    deliverControl(await buildResponse('v1', 'wrong-1'), 'v1');
    await vi.waitFor(() => expect(authResults('v1').some((ok) => ok === false)).toBe(true));
    expect(lockout.failCount(KEY)).toBe(1);
    // A fresh per-connection binding was used (not anchoring the lockout).
    expect(peerBus.bindingFor.get('v1')).toBeTruthy();
    viewerLeaves('v1');

    // --- Attempt 2: reconnect as "v2" (DIFFERENT viewerId + binding, SAME src) ---
    viewerJoins('v2', SRC);
    expect(peerBus.bindingFor.get('v2')).not.toBe(peerBus.bindingFor.get('v1'));
    deliverControl(await buildResponse('v2', 'wrong-2'), 'v2');
    await vi.waitFor(() => expect(authResults('v2').some((ok) => ok === false)).toBe(true));
    // The counter KEPT ACCUMULATING under the stable key — it did NOT reset.
    expect(lockout.failCount(KEY)).toBe(2);
    viewerLeaves('v2');

    // --- Attempt 3: reconnect as "v3" — trips the threshold => LOCKED ---
    viewerJoins('v3', SRC);
    deliverControl(await buildResponse('v3', 'wrong-3'), 'v3');
    await vi.waitFor(() => expect(authResults('v3').some((ok) => ok === false)).toBe(true));
    expect(lockout.failCount(KEY)).toBe(3);
    expect(lockout.check(KEY).locked).toBe(true);

    // --- Attempt 4: a brand-new connection from the same source is LOCKED OUT
    // (no KDF run). Even the CORRECT PIN is refused while locked, proving the
    // online brute-force defense now actually engages across reconnects. ---
    viewerJoins('v4', SRC);
    deliverControl(await buildResponse('v4', PIN), 'v4');
    await vi.waitFor(() => expect(authResults('v4').some((ok) => ok === false)).toBe(true));
    expect(session.isAuthorized('v4')).toBe(false);

    session.stop();
  });

  it('falls back to the per-connection channel binding when signaling omits sourceAddr (older server)', async () => {
    let now = 0;
    const lockout = new LockoutTracker({ threshold: 5, baseMs: 1000, now: () => now });
    const session = await startSession({ mode: 'pin', lockout });

    // No sourceAddr provided → lockout keyed on { ip: channelBinding, peerId: viewerId }.
    viewerJoins('v1'); // sourceAddr undefined
    deliverControl(await buildResponse('v1', 'wrong'), 'v1');
    await vi.waitFor(() => expect(authResults('v1').some((ok) => ok === false)).toBe(true));

    const binding = peerBus.bindingFor.get('v1')!;
    expect(lockout.failCount({ ip: binding, peerId: 'v1' })).toBe(1);
    // It is NOT recorded under any stable-source key.
    expect(lockout.failCount({ ip: 'v1', peerId: 'v1' })).toBe(0);

    session.stop();
  });
});

// ===========================================================================
// P2 — protected-mode host file send reaches ONLY authorized viewers.
// ===========================================================================
describe('P2: host file sends are restricted to authorized viewers in protected modes', () => {
  it('sendFile() with NO target reaches ONLY authorized viewer A, never unapproved viewer B', async () => {
    const session = await startSession({ mode: 'pin' });

    // A authorizes; B joins but never passes the PIN (control/file channels open).
    viewerJoins('A', '198.51.100.1');
    viewerJoins('B', '198.51.100.2');
    await authorize(session, 'A');
    expect(session.isAuthorized('A')).toBe(true);
    expect(session.isAuthorized('B')).toBe(false);

    peerBus.fileFrames = []; // ignore any auth-time frames
    await session.sendFile({ name: 'secret.bin', mime: 'application/octet-stream', data: new Uint8Array([1, 2, 3, 4]) });

    // Offer + chunk went to A only; NOTHING to B and NOTHING broadcast (to undefined).
    const targets = peerBus.fileFrames.map((f) => f.to);
    expect(peerBus.fileFrames.some((f) => f.kind === 'offer' && f.to === 'A')).toBe(true);
    expect(peerBus.fileFrames.some((f) => f.kind === 'chunk' && f.to === 'A')).toBe(true);
    expect(targets).not.toContain('B');
    expect(targets).not.toContain(undefined);
    expect(new Set(targets)).toEqual(new Set(['A']));

    session.stop();
  });

  it('sendFile() with an explicit UNAUTHORIZED target is refused (throws, sends nothing)', async () => {
    const session = await startSession({ mode: 'pin' });
    viewerJoins('A', '198.51.100.1');
    viewerJoins('B', '198.51.100.2');
    await authorize(session, 'A');

    peerBus.fileFrames = [];
    await expect(
      session.sendFile(
        { name: 'x.bin', mime: 'application/octet-stream', data: new Uint8Array([9]) },
        undefined,
        'B',
      ),
    ).rejects.toThrow(/not authorized/);
    expect(peerBus.fileFrames).toHaveLength(0);

    session.stop();
  });

  it('protected mode with NO authorized viewers sends nothing on a no-target sendFile', async () => {
    const session = await startSession({ mode: 'pin' });
    viewerJoins('B', '198.51.100.2'); // joined but never authorized
    peerBus.fileFrames = [];
    await session.sendFile({ name: 'x.bin', mime: 'application/octet-stream', data: new Uint8Array([1]) });
    expect(peerBus.fileFrames).toHaveLength(0);
    session.stop();
  });

  it('OPEN mode still broadcasts to all (single send, target undefined) — unchanged', async () => {
    const session = await startSession({ mode: 'open' });
    viewerJoins('A', '198.51.100.1');
    viewerJoins('B', '198.51.100.2');

    peerBus.fileFrames = [];
    await session.sendFile({ name: 'pub.bin', mime: 'application/octet-stream', data: new Uint8Array([1, 2]) });

    // Legacy behavior: a SINGLE broadcast transfer with target undefined that the
    // Peer fans out to all connections. The offer is sent once to undefined.
    const offers = peerBus.fileFrames.filter((f) => f.kind === 'offer');
    expect(offers).toHaveLength(1);
    expect(offers[0]!.to).toBeUndefined();

    session.stop();
  });
});
