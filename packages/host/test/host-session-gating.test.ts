/**
 * Integration tests for HOST-side ACCESS GATING in {@link HostSession}.
 *
 * Asserts the security flow per mode, with the Peer/SignalingClient faked (no
 * Electron, no WebRTC, no native deps) but the REAL crypto-auth + AuthVerifier +
 * LockoutTracker + ConsentManager driving the decisions:
 *
 *   - 'open'   : media attaches immediately; input flows — UNCHANGED legacy.
 *   - 'pin'    : NO attachStream and NO input until a valid proof; a wrong proof
 *                yields auth-result{ok:false}, no stream, and a lockout bump.
 *   - 'prompt' : stream/input only after the host human accepts.
 *
 * A tiny KDF iteration count keeps the PBKDF2 fast.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ControlMessage, InputEvent } from '@stream-screen/core';

// ---------------------------------------------------------------------------
// Fakes. The FakePeer captures the host's onControl/onInput handlers so the test
// can deliver viewer frames, and records sendControl + attachStream calls. The
// FakeSignalingClient lets the test fire a viewer 'peer-joined'.
// ---------------------------------------------------------------------------

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
  /** Session-wide attachStream() calls (open mode). */
  attachCount: number;
  /** Per-viewer attachStreamTo() calls (protected modes), in order. */
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
      // LATE-SUBSCRIBER SAFE: replay channels already open to this subscriber,
      // matching the real Peer contract the host relies on.
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
    // Real-shaped guard so HostSession.start can validate the `joined` ack's
    // optional iceServers (ICE config integration). Empty/absent => LAN-only.
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

async function startSession(opts: StartOpts): Promise<{
  session: HostSession;
  inputs: { e: InputEvent; viewerId: string }[];
}> {
  resetBus();
  const inputs: { e: InputEvent; viewerId: string }[] = [];
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
    onInput: (e, viewerId) => inputs.push({ e, viewerId }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: async () => new FakeMediaStream() as any,
  });
  await session.start();
  return { session, inputs };
}

/**
 * Fire a viewer joining the room, then open its WebRTC control channel. The
 * real flow is: signaling 'peer-joined' (name captured) → the Peer stands up
 * that viewer's RTCPeerConnection → its 'control' channel opens (onControlOpen),
 * which is when the host begins auth. This helper reproduces that ordering so
 * the host's onControlOpen-driven auth (P1-A) actually fires.
 */
function viewerJoins(viewerId: string, name?: string): void {
  signalingBus!.emit('peer-joined', { type: 'peer-joined', role: 'viewer', from: viewerId, name });
  openControl(viewerId);
}

/** Open a viewer's control channel, notifying onControlOpen subscribers once. */
function openControl(viewerId: string): void {
  if (peerBus.openViewers.has(viewerId)) return;
  peerBus.openViewers.add(viewerId);
  for (const cb of [...peerBus.controlOpenHandlers]) cb(viewerId);
}

/** Deliver a control message from a viewer to the host's handlers. */
function deliverControl(m: ControlMessage, viewerId: string): void {
  for (const h of [...peerBus.controlHandlers]) h(m, viewerId);
}

/** Build the viewer's auth-response for the host's last-issued challenge. */
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
    name: 'Alice',
  };
}

const authResults = (viewerId: string): boolean[] =>
  peerBus.sent
    .filter((s) => s.to === viewerId && s.msg.t === 'auth-result')
    .map((s) => (s.msg as Extract<ControlMessage, { t: 'auth-result' }>).ok);

describe('HostSession access gating', () => {
  describe("'open' mode (legacy, unchanged)", () => {
    it('attaches the stream immediately on start (no viewer needed)', async () => {
      const { session } = await startSession({ mode: 'open' });
      expect(peerBus.attachCount).toBe(1);
      session.stop();
    });

    it('forwards input from any viewer with no challenge', async () => {
      const { session, inputs } = await startSession({ mode: 'open' });
      viewerJoins('viewer-1');
      // No auth-challenge is ever sent in open mode.
      expect(peerBus.sent.filter((s) => s.msg.t === 'auth-challenge')).toHaveLength(0);
      peerBus.inputHandler!({ t: 'm-move', x: 0.5, y: 0.5 }, 'viewer-1');
      expect(inputs).toHaveLength(1);
      session.stop();
    });
  });

  describe("'pin' mode", () => {
    it('does NOT attach the stream until a valid proof arrives', async () => {
      const { session } = await startSession({ mode: 'pin' });
      // No stream attached at start.
      expect(peerBus.attachCount).toBe(0);
      viewerJoins('viewer-1');
      // A challenge was issued, still no stream.
      expect(peerBus.sent.some((s) => s.to === 'viewer-1' && s.msg.t === 'auth-challenge')).toBe(true);
      expect(peerBus.attachCount).toBe(0);

      const resp = await buildResponse('viewer-1', PIN);
      deliverControl(resp, 'viewer-1');
      // Media is attached PER authorized viewer (attachStreamTo), NOT session-wide.
      await vi.waitFor(() => expect(peerBus.attachedTo).toEqual(['viewer-1']));
      expect(peerBus.attachCount).toBe(0);
      expect(authResults('viewer-1')).toContain(true);
      expect(session.isAuthorized('viewer-1')).toBe(true);
      session.stop();
    });

    it('DROPS input from an unauthorized viewer; forwards after a valid proof', async () => {
      const { session, inputs } = await startSession({ mode: 'pin' });
      viewerJoins('viewer-1');
      // Input before auth is dropped.
      peerBus.inputHandler!({ t: 'm-move', x: 0.1, y: 0.1 }, 'viewer-1');
      expect(inputs).toHaveLength(0);

      const resp = await buildResponse('viewer-1', PIN);
      deliverControl(resp, 'viewer-1');
      await vi.waitFor(() => expect(session.isAuthorized('viewer-1')).toBe(true));

      peerBus.inputHandler!({ t: 'm-move', x: 0.2, y: 0.2 }, 'viewer-1');
      expect(inputs).toHaveLength(1);
      session.stop();
    });

    it('a WRONG proof yields auth-result{ok:false}, no stream, and a lockout bump', async () => {
      let now = 0;
      const lockout = new LockoutTracker({ threshold: 5, baseMs: 1000, now: () => now });
      const { session } = await startSession({ mode: 'pin', lockout });
      viewerJoins('viewer-1');

      const resp = await buildResponse('viewer-1', 'wrong-pin');
      deliverControl(resp, 'viewer-1');
      await vi.waitFor(() =>
        expect(authResults('viewer-1').some((ok) => ok === false)).toBe(true),
      );
      expect(authResults('viewer-1')).not.toContain(true);
      expect(peerBus.attachCount).toBe(0);
      expect(session.isAuthorized('viewer-1')).toBe(false);
      // Lockout bumped for this (binding, peerId) key.
      expect(lockout.failCount({ ip: CB, peerId: 'viewer-1' })).toBe(1);
      session.stop();
    });

    it('never sends a failure REASON on the wire (auth-result is reason-free)', async () => {
      const { session } = await startSession({ mode: 'pin' });
      viewerJoins('viewer-1');
      const resp = await buildResponse('viewer-1', 'wrong-pin');
      deliverControl(resp, 'viewer-1');
      await vi.waitFor(() =>
        expect(authResults('viewer-1').some((ok) => ok === false)).toBe(true),
      );
      const fail = peerBus.sent.find(
        (s) => s.msg.t === 'auth-result' && (s.msg as { ok: boolean }).ok === false,
      )!;
      expect(Object.keys(fail.msg).sort()).toEqual(['ok', 't', 'v']);
      session.stop();
    });

    it('a captured proof cannot be replayed against a fresh challenge', async () => {
      const { session } = await startSession({ mode: 'pin' });
      viewerJoins('viewer-1');
      const resp = await buildResponse('viewer-1', PIN);
      // First, a real disconnect/rejoin would issue a NEW nonce. Simulate the host
      // re-challenging by having the viewer rejoin (clears state, new nonce).
      signalingBus!.emit('peer-left', { type: 'peer-left', role: 'viewer', from: 'viewer-1' });
      viewerJoins('viewer-1');
      // Replay the OLD proof (bound to the previous nonce) against the new challenge.
      deliverControl(resp, 'viewer-1');
      await vi.waitFor(() =>
        expect(authResults('viewer-1').some((ok) => ok === false)).toBe(true),
      );
      expect(session.isAuthorized('viewer-1')).toBe(false);
      session.stop();
    });
  });

  describe("'prompt' mode", () => {
    it('does not attach until the host human accepts; then attaches + forwards input', async () => {
      const consent = new ConsentManager();
      const { session, inputs } = await startSession({ mode: 'prompt', consent });
      viewerJoins('viewer-1', 'Alice');
      // P2-1: a prompt-mode auth-challenge (NO PIN proof material) is sent so the
      // viewer enters 'authenticating' and shows the waiting overlay. No PIN
      // challenge (with proof material) is ever issued in prompt mode.
      const promptChallenges = peerBus.sent.filter(
        (s) => s.to === 'viewer-1' && s.msg.t === 'auth-challenge',
      );
      expect(promptChallenges).toHaveLength(1);
      expect((promptChallenges[0]!.msg as { mode?: string }).mode).toBe('prompt');
      expect((promptChallenges[0]!.msg as { nonceH?: string }).nonceH).toBeUndefined();
      // A pending consent request is surfaced.
      await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
      expect(peerBus.attachCount).toBe(0);
      // Input dropped before accept.
      peerBus.inputHandler!({ t: 'm-move', x: 0.1, y: 0.1 }, 'viewer-1');
      expect(inputs).toHaveLength(0);

      consent.accept();
      await vi.waitFor(() => expect(session.isAuthorized('viewer-1')).toBe(true));
      // Per-viewer attach, never session-wide.
      expect(peerBus.attachedTo).toEqual(['viewer-1']);
      expect(peerBus.attachCount).toBe(0);
      expect(authResults('viewer-1')).toContain(true);

      peerBus.inputHandler!({ t: 'm-move', x: 0.2, y: 0.2 }, 'viewer-1');
      expect(inputs).toHaveLength(1);
      session.stop();
    });

    it('a rejected request never attaches and denies the viewer', async () => {
      const consent = new ConsentManager();
      const { session } = await startSession({ mode: 'prompt', consent });
      viewerJoins('viewer-1');
      await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
      consent.reject();
      await vi.waitFor(() =>
        expect(authResults('viewer-1').some((ok) => ok === false)).toBe(true),
      );
      expect(peerBus.attachCount).toBe(0);
      expect(session.isAuthorized('viewer-1')).toBe(false);
      session.stop();
    });
  });

  describe("'pin-and-prompt' mode", () => {
    it('requires BOTH a valid proof AND a human accept', async () => {
      const consent = new ConsentManager();
      const { session } = await startSession({ mode: 'pin-and-prompt', consent });
      viewerJoins('viewer-1');
      const resp = await buildResponse('viewer-1', PIN);
      deliverControl(resp, 'viewer-1');
      // Valid proof alone is NOT enough — a consent request now waits.
      await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
      expect(peerBus.attachCount).toBe(0);
      expect(session.isAuthorized('viewer-1')).toBe(false);

      consent.accept();
      await vi.waitFor(() => expect(session.isAuthorized('viewer-1')).toBe(true));
      expect(peerBus.attachedTo).toEqual(['viewer-1']);
      expect(peerBus.attachCount).toBe(0);
      session.stop();
    });

    it('a bad proof never reaches the consent prompt', async () => {
      const consent = new ConsentManager();
      const { session } = await startSession({ mode: 'pin-and-prompt', consent });
      viewerJoins('viewer-1');
      const resp = await buildResponse('viewer-1', 'wrong-pin');
      deliverControl(resp, 'viewer-1');
      await vi.waitFor(() =>
        expect(authResults('viewer-1').some((ok) => ok === false)).toBe(true),
      );
      expect(consent.pending).toHaveLength(0);
      expect(peerBus.attachCount).toBe(0);
      session.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // P1 security regressions: control-channel-timed auth (P1-A) and per-viewer
  // (non-session-wide) media attach (P1-B). These fail against the pre-fix host
  // (auth begun from the signaling join; session-wide attachStream on authorize).
  // ---------------------------------------------------------------------------
  describe('P1-A: auth begins on control-channel open, not signaling join', () => {
    it('does NOT send the challenge at signaling join — only once the control channel opens', async () => {
      const { session } = await startSession({ mode: 'pin' });
      // Viewer joins signaling, but its WebRTC control channel is NOT open yet.
      signalingBus!.emit('peer-joined', {
        type: 'peer-joined',
        role: 'viewer',
        from: 'viewer-late',
      });
      // Pre-fix the host called beginAuth() here and the challenge was dropped on
      // the closed channel. Post-fix no challenge is even attempted until open.
      expect(
        peerBus.sent.some((s) => s.to === 'viewer-late' && s.msg.t === 'auth-challenge'),
      ).toBe(false);

      // Now the control channel opens — THIS is when auth must (re)start, and the
      // challenge is actually deliverable.
      openControl('viewer-late');
      expect(
        peerBus.sent.some((s) => s.to === 'viewer-late' && s.msg.t === 'auth-challenge'),
      ).toBe(true);
      session.stop();
    });

    it('prompt mode: consent request is raised on control-open, not before', async () => {
      const consent = new ConsentManager();
      const { session } = await startSession({ mode: 'prompt', consent });
      signalingBus!.emit('peer-joined', {
        type: 'peer-joined',
        role: 'viewer',
        from: 'viewer-late',
        name: 'Late',
      });
      // No consent yet — the control channel has not opened.
      expect(consent.pending).toHaveLength(0);
      openControl('viewer-late');
      await vi.waitFor(() => expect(consent.pending).toHaveLength(1));
      session.stop();
    });
  });

  describe('P1-B: media attaches per authorized viewer, never session-wide', () => {
    it('an unapproved viewer already in the room never receives media (or input) after another is approved', async () => {
      const { session, inputs } = await startSession({ mode: 'pin' });
      // TWO viewers join and both open their control channels.
      viewerJoins('viewer-A');
      viewerJoins('viewer-B');
      // Only viewer-A passes the PIN.
      const respA = await buildResponse('viewer-A', PIN);
      deliverControl(respA, 'viewer-A');
      await vi.waitFor(() => expect(session.isAuthorized('viewer-A')).toBe(true));

      // Media attached ONLY to viewer-A; NEVER session-wide (which would replay
      // the stream onto viewer-B's already-open connection). viewer-B gets nothing.
      expect(peerBus.attachedTo).toEqual(['viewer-A']);
      expect(peerBus.attachCount).toBe(0);
      expect(session.isAuthorized('viewer-B')).toBe(false);

      // viewer-A's input flows; viewer-B's input (unauthorized) is dropped.
      peerBus.inputHandler!({ t: 'm-move', x: 0.3, y: 0.3 }, 'viewer-A');
      peerBus.inputHandler!({ t: 'm-move', x: 0.9, y: 0.9 }, 'viewer-B');
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.viewerId).toBe('viewer-A');
      session.stop();
    });

    it('a viewer that joins AFTER an approval does not auto-receive the replayed stream', async () => {
      const { session } = await startSession({ mode: 'pin' });
      viewerJoins('viewer-A');
      const respA = await buildResponse('viewer-A', PIN);
      deliverControl(respA, 'viewer-A');
      await vi.waitFor(() => expect(session.isAuthorized('viewer-A')).toBe(true));

      // A NEW viewer joins after viewer-A was approved. Session-wide attach would
      // have stored localStream and replayed it onto viewer-B's fresh connection;
      // per-viewer attach does not, so viewer-B receives nothing until it authorizes.
      viewerJoins('viewer-B');
      // viewer-B is challenged (P1-A) but not authorized, and gets no media.
      expect(
        peerBus.sent.some((s) => s.to === 'viewer-B' && s.msg.t === 'auth-challenge'),
      ).toBe(true);
      expect(peerBus.attachedTo).toEqual(['viewer-A']);
      expect(peerBus.attachCount).toBe(0);
      expect(session.isAuthorized('viewer-B')).toBe(false);

      // When viewer-B finally authorizes, IT gets its own per-connection attach.
      const respB = await buildResponse('viewer-B', PIN);
      deliverControl(respB, 'viewer-B');
      await vi.waitFor(() => expect(session.isAuthorized('viewer-B')).toBe(true));
      expect(peerBus.attachedTo).toEqual(['viewer-A', 'viewer-B']);
      expect(peerBus.attachCount).toBe(0);
      session.stop();
    });
  });

  describe("'refuse' mode (fail-closed misconfig)", () => {
    it('refuses every viewer: no challenge, no stream, denies', async () => {
      const { session } = await startSession({ mode: 'refuse' });
      viewerJoins('viewer-1');
      await vi.waitFor(() =>
        expect(authResults('viewer-1').some((ok) => ok === false)).toBe(true),
      );
      expect(peerBus.sent.some((s) => s.msg.t === 'auth-challenge')).toBe(false);
      expect(peerBus.attachCount).toBe(0);
      expect(session.isAuthorized('viewer-1')).toBe(false);
      session.stop();
    });
  });
});
