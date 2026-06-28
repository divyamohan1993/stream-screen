import { describe, it, expect } from 'vitest';
import { Peer } from '../src/peer.js';
import type { SignalMessage } from '../src/protocol.js';
import type { SignalingClient } from '../src/signaling-client.js';

/**
 * The Peer must construct every RTCPeerConnection with EXACTLY the configured
 * ICE-server list (OPT-IN, for connecting across the internet via operator-
 * supplied STUN/TURN). When omitted, the LAN-only default is preserved: no ICE
 * servers (empty list).
 */

type Handler = (m: SignalMessage) => void;

class FakeSignaling {
  private readonly handlers = new Map<string, Handler[]>();
  on(type: string, cb: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  send(): void {}
  fire(type: string, m: SignalMessage): void {
    for (const cb of this.handlers.get(type) ?? []) cb(m);
  }
}

/** RTCPeerConnection stub that records the config object it was constructed with. */
class FakePC {
  static configs: RTCConfiguration[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: unknown = { type: 'offer', sdp: 'v=0' };
  restartIce = (): void => {};
  setLocalDescription = async (): Promise<void> => {};
  setRemoteDescription = async (): Promise<void> => {};
  addIceCandidate = async (): Promise<void> => {};
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  ondatachannel: unknown = null;
  onnegotiationneeded: (() => void) | null = null;
  constructor(config: RTCConfiguration) {
    FakePC.configs.push(config);
  }
  createDataChannel(): { label: string; close(): void } {
    return { label: 'x', close() {} };
  }
  addTrack(): void {}
  getSenders(): unknown[] {
    return [];
  }
  getReceivers(): unknown[] {
    return [];
  }
  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
  close(): void {}
}

function makePeer(iceServers?: RTCIceServer[]) {
  FakePC.configs = [];
  const signaling = new FakeSignaling();
  const peer = new Peer({
    role: 'host',
    signaling: signaling as unknown as SignalingClient,
    rtcPeerConnection: FakePC as unknown as typeof RTCPeerConnection,
    iceServers,
  });
  return { peer, signaling };
}

describe('Peer ICE configuration', () => {
  it('constructs the RTCPeerConnection with exactly the provided iceServers', async () => {
    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ];
    const { peer, signaling } = makePeer(iceServers);
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });

    expect(FakePC.configs).toHaveLength(1);
    expect(FakePC.configs[0].iceServers).toEqual(iceServers);
    // Exposed via getter for callers/tests.
    expect(peer.getIceServers()).toEqual(iceServers);
  });

  it('defaults to an empty ICE list (LAN-only) when omitted', async () => {
    const { peer, signaling } = makePeer();
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });

    expect(FakePC.configs).toHaveLength(1);
    expect(FakePC.configs[0].iceServers).toEqual([]);
    expect(peer.getIceServers()).toEqual([]);
  });

  it('every per-viewer connection gets the same iceServers', async () => {
    const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];
    const { peer, signaling } = makePeer(iceServers);
    await peer.start();
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-A' });
    signaling.fire('peer-joined', { type: 'peer-joined', from: 'viewer-B' });

    expect(FakePC.configs).toHaveLength(2);
    for (const cfg of FakePC.configs) expect(cfg.iceServers).toEqual(iceServers);
  });

  it('getIceServers returns a defensive copy (cannot mutate internal state)', () => {
    const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];
    const { peer } = makePeer(iceServers);
    const got = peer.getIceServers();
    got.push({ urls: 'turn:evil.example.com' });
    (got[0] as RTCIceServer).urls = 'mutated';
    expect(peer.getIceServers()).toEqual([{ urls: 'stun:stun.example.com:3478' }]);
  });

  it('a later mutation of the caller-passed array does not affect the peer', () => {
    const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }];
    const { peer } = makePeer(iceServers);
    iceServers.push({ urls: 'turn:evil.example.com' });
    expect(peer.getIceServers()).toEqual([{ urls: 'stun:stun.example.com:3478' }]);
  });
});
