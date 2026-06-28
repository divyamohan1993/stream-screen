/**
 * HOST-side auth follow-up regressions in {@link HostSession}:
 *
 *   P2-1 (prompt mode): in 'prompt' mode the host MUST send an
 *     auth-challenge{mode:'prompt'} (carrying NO PIN proof material) to the
 *     viewer at control-open BEFORE running the consent gate, so the viewer
 *     enters 'authenticating' and shows the "waiting for host approval" overlay.
 *     On a consent reject the viewer gets auth-result{ok:false} (denied), and the
 *     stream is never attached. Before the fix the host went straight to consent
 *     and the viewer never received a challenge (looking connected while media
 *     was withheld).
 *
 *   P2-2 (PIN retry): on a failed-but-NOT-locked PIN attempt the host consumes
 *     the viewer's nonce, denies, and then sends a FRESH auth-challenge with a
 *     NEW nonceH so the viewer can retry WITHOUT reconnecting. Once the viewer is
 *     LOCKED OUT, NO fresh challenge is sent (the viewer shows locked/denied and
 *     waits out the backoff). Before the fix the host deleted the nonce and sent
 *     no replacement, so every retry against the consumed nonce failed until a
 *     disconnect+rejoin.
 *
 * Peer/SignalingClient are faked (no Electron/WebRTC/native deps); the REAL
 * crypto-auth + AuthVerifier + LockoutTracker + ConsentManager drive decisions.
 * A tiny KDF iteration count keeps PBKDF2 fast.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ControlMessage, InputEvent } from '@stream-screen/core';

interface SentControl {
  msg: ControlMessage;
  to?: string;
}

const peerBus: {
  controlHandlers: ((m: ControlMessage, viewerId: string) => void)[];
  inputHandler: ((e: InputEvent, viewerId: string) => void) | null;
  controlOpenHandlers: ((remoteId: string) => void)[];
  openViewers: Set<string>;
  sent: SentControl[];
  attachCount: number;
  attachedTo: string[];
  channelBinding: string;
} = {
  controlHandlers: [],
  inputHandler: null,
  controlOpenHandlers: [],
  openViewers: new Set(),
  sent: [],
  attachCount: 0,
  attachedTo: [],
  channelBinding: 'fpHost|fpViewer',
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
    onInput(cb: (e: InputEvent, viewerId: string) => void): void {
      peerBus.inputHandler = cb;
    }
    on(): void {}
    onFileChunk(): void {}
    onControl(cb: (m: ControlMessage, viewerId: string) => void): () => void {
      peerBus.controlHandlers.push(cb);
      return () => {
        peerBus.controlHandlers = peerBus.controlHandlers.filter((h) => h !== cb);
      };
    }
    async start(): Promise<void> {}
    attachStream(): void {
      peerBus.attachCount += 1;
    }
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
    }
    getChannelBinding(): string {
      return peerBus.channelBinding;
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
    createSender: vi.fn(),
    __FakeMediaStream: FakeMediaStream,
  };
});

import { HostSession } from '../src/host-session.js';
import { ConsentManager } from '../src/consent-manager.js';
import { LockoutTracker } from '../src/lockout-tracker.js';
import type { AccessMode } from '../src/access-config.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (): unknown };

const ITERS = 100;
const PIN = 'goodpin99';
const CB = 'fpHost|fpViewer';

type AuthChallenge = Extract<ControlMessage, { t: 'auth-challenge' }>;

function resetBus(): void {
  peerBus.controlHandlers = [];
  peerBus.inputHandler = null;
  peerBus.controlOpenHandlers = [];
  peerBus.openViewers = new Set();
  peerBus.sent = [];
  peerBus.attachCount = 0;
  peerBus.attachedTo = [];
  peerBus.channelBinding = CB;
  signalingBus = null;
}

interface StartOpts {
  mode: AccessMode;
  consent?: ConsentManager;
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
    consent: opts.consent,
    lockout: opts.lockout,
    onInput: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: async () => new FakeMediaStream() as any,
  });
  await session.start();
  return session;
}

function viewerJoins(viewerId: string, name?: string): void {
  signalingBus!.emit('peer-joined', { type: 'peer-joined', role: 'viewer', from: viewerId, name });
  if (peerBus.openViewers.has(viewerId)) return;
  peerBus.openViewers.add(viewerId);
  for (const cb of [...peerBus.controlOpenHandlers]) cb(viewerId);
}

function deliverControl(m: ControlMessage, viewerId: string): void {
  for (const h of [...peerBus.controlHandlers]) h(m, viewerId);
}

const challengesFor = (viewerId: string): AuthChallenge[] =>
  peerBus.sent
    .filter((s) => s.to === viewerId && s.msg.t === 'auth-challenge')
    .map((s) => s.msg as AuthChallenge);

const authResults = (viewerId: string): boolean[] =>
  peerBus.sent
    .filter((s) => s.to === viewerId && s.msg.t === 'auth-result')
    .map((s) => (s.msg as Extract<ControlMessage, { t: 'auth-result' }>).ok);

/** Build a viewer auth-response for the host's LAST-issued challenge. */
async function buildResponse(viewerId: string, pin: string): Promise<ControlMessage> {
  const challenge = challengesFor(viewerId).pop();
  expect(challenge).toBeTruthy();
  const c = challenge!;
  const salt = core.fromBase64(c.salt!);
  const nonceH = core.fromBase64(c.nonceH!);
  const nonceV = core.randomBytes(core.NONCE_BYTES);
  const key = await core.deriveKey(pin, salt, c.iterations!);
  const proof = await core.computeProof(key, {
    domain: core.AUTH_DOMAIN,
    nonceH,
    nonceV,
    channelBinding: c.channelBinding!,
  });
  return {
    t: 'auth-response',
    v: 1,
    nonceV: core.toBase64(nonceV),
    proof: core.toBase64(proof),
    name: 'Alice',
  };
}

describe('P2-1: prompt-mode auth-challenge', () => {
  it('sends an auth-challenge{mode:\'prompt\'} (no PIN material) before running consent', async () => {
    const consent = new ConsentManager();
    const session = await startSession({ mode: 'prompt', consent });
    viewerJoins('viewer-1', 'Alice');

    const challenges = challengesFor('viewer-1');
    expect(challenges).toHaveLength(1);
    const c = challenges[0]!;
    expect(c.mode).toBe('prompt');
    // No PIN proof material is present in a prompt challenge.
    expect(c.nonceH).toBeUndefined();
    expect(c.salt).toBeUndefined();
    expect(c.iterations).toBeUndefined();
    expect(c.channelBinding).toBeUndefined();
    // Only t/v/mode are present on the wire.
    expect(Object.keys(c).sort()).toEqual(['mode', 't', 'v']);

    // The consent gate is now pending (challenge precedes/accompanies it).
    await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
    expect(peerBus.attachCount).toBe(0);
    expect(peerBus.attachedTo).toHaveLength(0);
    session.stop();
  });

  it('on consent reject: viewer is denied (auth-result{ok:false}) and never attached', async () => {
    const consent = new ConsentManager();
    const session = await startSession({ mode: 'prompt', consent });
    viewerJoins('viewer-1');

    // The prompt challenge was sent first (so the viewer is "authenticating").
    expect(challengesFor('viewer-1')).toHaveLength(1);
    expect(challengesFor('viewer-1')[0]!.mode).toBe('prompt');

    await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
    consent.reject();
    await vi.waitFor(() => expect(authResults('viewer-1')).toContain(false));
    expect(authResults('viewer-1')).not.toContain(true);
    expect(session.isAuthorized('viewer-1')).toBe(false);
    expect(peerBus.attachCount).toBe(0);
    expect(peerBus.attachedTo).toHaveLength(0);
    session.stop();
  });

  it('on consent accept: viewer is authorized and attached (challenge did not block accept)', async () => {
    const consent = new ConsentManager();
    const session = await startSession({ mode: 'prompt', consent });
    viewerJoins('viewer-1');
    await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
    consent.accept();
    await vi.waitFor(() => expect(session.isAuthorized('viewer-1')).toBe(true));
    expect(peerBus.attachedTo).toEqual(['viewer-1']);
    expect(authResults('viewer-1')).toContain(true);
    session.stop();
  });
});

describe('P2-2: fresh PIN challenge on a failed-but-not-locked attempt', () => {
  it('a wrong PIN (not locked) results in a NEW auth-challenge with a DIFFERENT nonceH', async () => {
    let now = 0;
    const lockout = new LockoutTracker({ threshold: 5, baseMs: 1000, now: () => now });
    const session = await startSession({ mode: 'pin', lockout });
    viewerJoins('viewer-1');

    const first = challengesFor('viewer-1');
    expect(first).toHaveLength(1);
    const firstNonce = first[0]!.nonceH;

    // Submit a WRONG proof bound to the first nonce.
    const badResp = await buildResponse('viewer-1', 'wrong-pin');
    deliverControl(badResp, 'viewer-1');

    // Host denied AND re-challenged with a FRESH nonce (P2-2): retry w/o rejoin.
    await vi.waitFor(() => expect(authResults('viewer-1')).toContain(false));
    await vi.waitFor(() => expect(challengesFor('viewer-1')).toHaveLength(2));
    const second = challengesFor('viewer-1');
    expect(second[1]!.mode).toBe('pin');
    expect(second[1]!.nonceH).toBeTruthy();
    // The new nonce is DIFFERENT from the consumed one (no replay of a dead nonce).
    expect(second[1]!.nonceH).not.toBe(firstNonce);
    expect(session.isAuthorized('viewer-1')).toBe(false);

    // The viewer can now retry with the CORRECT PIN against the fresh challenge —
    // no disconnect/rejoin needed — and is authorized.
    const goodResp = await buildResponse('viewer-1', PIN);
    deliverControl(goodResp, 'viewer-1');
    await vi.waitFor(() => expect(session.isAuthorized('viewer-1')).toBe(true));
    expect(authResults('viewer-1')).toContain(true);
    session.stop();
  });

  it('once LOCKED OUT, NO fresh auth-challenge is sent', async () => {
    let now = 0;
    // threshold:1 → the very first failure locks the key for baseMs.
    const lockout = new LockoutTracker({ threshold: 1, baseMs: 1000, now: () => now });
    const session = await startSession({ mode: 'pin', lockout });
    viewerJoins('viewer-1');

    expect(challengesFor('viewer-1')).toHaveLength(1);

    const badResp = await buildResponse('viewer-1', 'wrong-pin');
    deliverControl(badResp, 'viewer-1');

    await vi.waitFor(() => expect(authResults('viewer-1')).toContain(false));
    // The key is now locked, so NO replacement challenge is issued — only the
    // original challenge remains. The viewer shows locked/denied and must wait.
    expect(challengesFor('viewer-1')).toHaveLength(1);
    expect(lockout.check({ ip: CB, peerId: 'viewer-1' }).locked).toBe(true);
    expect(session.isAuthorized('viewer-1')).toBe(false);
    session.stop();
  });

  it('sends a fresh challenge on EACH non-locked failure up to the threshold, then stops', async () => {
    let now = 0;
    // threshold:3 → failures #1 and #2 are not locked (fresh challenge each),
    // failure #3 trips the lockout (no fresh challenge).
    const lockout = new LockoutTracker({ threshold: 3, baseMs: 1000, now: () => now });
    const session = await startSession({ mode: 'pin', lockout });
    viewerJoins('viewer-1');

    // Failure #1.
    deliverControl(await buildResponse('viewer-1', 'wrong-pin'), 'viewer-1');
    await vi.waitFor(() => expect(challengesFor('viewer-1')).toHaveLength(2));
    // Failure #2 (still below threshold → another fresh challenge).
    deliverControl(await buildResponse('viewer-1', 'wrong-pin'), 'viewer-1');
    await vi.waitFor(() => expect(challengesFor('viewer-1')).toHaveLength(3));
    // Failure #3 trips the lockout → NO further challenge.
    deliverControl(await buildResponse('viewer-1', 'wrong-pin'), 'viewer-1');
    await vi.waitFor(() =>
      expect(authResults('viewer-1').filter((ok) => ok === false)).toHaveLength(3),
    );
    expect(challengesFor('viewer-1')).toHaveLength(3);
    expect(lockout.check({ ip: CB, peerId: 'viewer-1' }).locked).toBe(true);
    session.stop();
  });

  it('all re-issued nonces are unique (each retry binds to a brand-new nonce)', async () => {
    let now = 0;
    const lockout = new LockoutTracker({ threshold: 5, baseMs: 1000, now: () => now });
    const session = await startSession({ mode: 'pin', lockout });
    viewerJoins('viewer-1');

    deliverControl(await buildResponse('viewer-1', 'wrong-pin'), 'viewer-1');
    await vi.waitFor(() => expect(challengesFor('viewer-1')).toHaveLength(2));
    deliverControl(await buildResponse('viewer-1', 'wrong-pin'), 'viewer-1');
    await vi.waitFor(() => expect(challengesFor('viewer-1')).toHaveLength(3));

    const nonces = challengesFor('viewer-1').map((c) => c.nonceH);
    expect(new Set(nonces).size).toBe(nonces.length);
    session.stop();
  });
});
