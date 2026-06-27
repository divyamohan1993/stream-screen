import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, SignalMessage } from '@stream-screen/core';

/**
 * Regression for FINDING B: in a multi-viewer room the signaling server emits
 * `peer-left` for ANY departing peer — including OTHER viewers. The viewer
 * session must only downgrade to `waiting-for-host` when the departed peer is
 * the HOST (`role === 'host'`); a viewer's departure leaves the host stream
 * intact and must NOT change session state.
 */

type StateCb = (s: RTCPeerConnectionState) => void;

class FakePeer {
  static current: FakePeer | null = null;
  stateCb: StateCb | null = null;
  constructor() {
    FakePeer.current = this;
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'state') this.stateCb = cb as StateCb;
  }
  async start(): Promise<void> {}
  onControl(_cb: (m: ControlMessage) => void): void {}
  onFileChunk(_cb: (b: ArrayBuffer) => void): void {}
  onInput(_cb: (e: InputEvent) => void): void {}
  sendControl(): void {}
  close(): void {}
  emitState(s: RTCPeerConnectionState): void {
    this.stateCb?.(s);
  }
}

type PeerLeftCb = (m: SignalMessage) => void;

class FakeSignaling {
  peerLeftCb: PeerLeftCb | null = null;
  on(ev: string, cb: (...a: unknown[]) => void): void {
    if (ev === 'peer-left') this.peerLeftCb = cb as PeerLeftCb;
  }
  async connect(): Promise<void> {}
  join(): void {}
  close(): void {}
  /** Drive a synthetic peer-left for the given role. */
  emitPeerLeft(role: SignalMessage['role']): void {
    this.peerLeftCb?.({ type: 'peer-left', role });
  }
}

let lastSignaling: FakeSignaling | null = null;
const SignalingProxy = class extends FakeSignaling {
  constructor() {
    super();
    lastSignaling = this;
  }
};

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: SignalingProxy };
});

const { ViewerSession } = await import('./viewer-session.js');

async function connected() {
  const session = new ViewerSession({ code: '123456', signalingUrl: 'ws://x:8787' });
  await session.connect();
  FakePeer.current!.emitState('connected');
  return session;
}

describe('ViewerSession peer-left role handling', () => {
  beforeEach(() => {
    FakePeer.current = null;
    lastSignaling = null;
  });

  it('ignores peer-left for a non-host peer (another viewer) — state unchanged', async () => {
    const session = await connected();
    expect(session.currentState).toBe('connected');
    lastSignaling!.emitPeerLeft('viewer');
    // Another viewer leaving must NOT drop us to waiting-for-host.
    expect(session.currentState).toBe('connected');
  });

  it('transitions to waiting-for-host when the HOST leaves', async () => {
    const session = await connected();
    lastSignaling!.emitPeerLeft('host');
    expect(session.currentState).toBe('waiting-for-host');
  });

  it('ignores a role-less peer-left (no host departure asserted)', async () => {
    const session = await connected();
    lastSignaling!.emitPeerLeft(undefined);
    expect(session.currentState).toBe('connected');
  });
});
