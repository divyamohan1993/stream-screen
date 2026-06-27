import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SignalMessage } from '@stream-screen/core';
import { SignalingServer, generateCode } from '../src/server.js';

/** Open a ws client and resolve once connected. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the next message of `type` (optionally) on a socket. */
function nextMessage(ws: WebSocket, type?: SignalMessage['type']): Promise<SignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${type ?? 'any'} message`));
    }, 4000);
    const onMsg = (data: Buffer) => {
      const msg = JSON.parse(data.toString('utf8')) as SignalMessage;
      if (type && msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    };
    ws.on('message', onMsg);
  });
}

function send(ws: WebSocket, msg: SignalMessage): void {
  ws.send(JSON.stringify(msg));
}

describe('SignalingServer', () => {
  let server: SignalingServer;
  let port: number;

  beforeEach(() => {
    // Ephemeral port; disable heartbeat so it cannot interfere with tests.
    server = new SignalingServer({ port: 0, heartbeatMs: 0 });
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  it('generates numeric codes of the requested length with no leading zero', () => {
    for (const digits of [6, 7, 8, 9]) {
      const code = generateCode(digits);
      expect(code).toMatch(new RegExp(`^[1-9]\\d{${digits - 1}}$`));
    }
  });

  it('mints a code for a host that joins without one', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'My PC' });
    const joined = await nextMessage(host, 'joined');
    expect(joined.code).toBeTruthy();
    expect(joined.code).toMatch(/^[1-9]\d{5,8}$/);
    expect(joined.from).toBeTruthy();
    host.close();
  });

  it('relays an offer from host to viewer, and ice both ways', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Host PC', code: '123456' });
    const hostJoined = await nextMessage(host, 'joined');
    const code = hostJoined.code!;
    const hostId = hostJoined.from!;

    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', name: 'Viewer', code });
    const viewerJoined = await nextMessage(viewer, 'joined');
    const viewerId = viewerJoined.from!;

    // Host learns a peer joined.
    const peerJoined = await nextMessage(host, 'peer-joined');
    expect(peerJoined.from).toBe(viewerId);
    expect(peerJoined.role).toBe('viewer');

    // Host sends an offer addressed to the viewer; viewer receives it.
    const offerPromise = nextMessage(viewer, 'offer');
    send(host, {
      type: 'offer',
      to: viewerId,
      sdp: { type: 'offer', sdp: 'v=0-test-sdp' },
    });
    const offer = await offerPromise;
    expect(offer.sdp?.sdp).toBe('v=0-test-sdp');
    expect(offer.from).toBe(hostId);

    // Viewer answers back to the host.
    const answerPromise = nextMessage(host, 'answer');
    send(viewer, {
      type: 'answer',
      to: hostId,
      sdp: { type: 'answer', sdp: 'v=0-answer-sdp' },
    });
    const answer = await answerPromise;
    expect(answer.sdp?.sdp).toBe('v=0-answer-sdp');
    expect(answer.from).toBe(viewerId);

    // ICE candidate relayed host -> viewer.
    const icePromise = nextMessage(viewer, 'ice');
    send(host, {
      type: 'ice',
      to: viewerId,
      candidate: { candidate: 'candidate:1 udp', sdpMLineIndex: 0 },
    });
    const ice = await icePromise;
    expect(ice.candidate?.candidate).toBe('candidate:1 udp');
    expect(ice.from).toBe(hostId);

    host.close();
    viewer.close();
  });

  it('broadcasts ice to the room when no explicit target is set', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', code: '222333' });
    const hostJoined = await nextMessage(host, 'joined');
    const code = hostJoined.code!;

    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', code });
    await nextMessage(viewer, 'joined');
    await nextMessage(host, 'peer-joined');

    const icePromise = nextMessage(viewer, 'ice');
    send(host, { type: 'ice', candidate: { candidate: 'broadcast-cand' } });
    const ice = await icePromise;
    expect(ice.candidate?.candidate).toBe('broadcast-cand');

    host.close();
    viewer.close();
  });

  it('rejects a viewer joining a non-existent session', async () => {
    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', code: '999888' });
    const err = await nextMessage(viewer, 'error');
    expect(err.message).toBe('no-such-session');
    viewer.close();
  });

  it('fires peer-left to remaining peers when one disconnects', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', code: '444555' });
    const hostJoined = await nextMessage(host, 'joined');
    const code = hostJoined.code!;

    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', code });
    const viewerJoined = await nextMessage(viewer, 'joined');
    const viewerId = viewerJoined.from!;
    await nextMessage(host, 'peer-joined');

    const leftPromise = nextMessage(host, 'peer-left');
    viewer.close();
    const left = await leftPromise;
    expect(left.from).toBe(viewerId);
    expect(left.role).toBe('viewer');

    host.close();
  });

  it('answers ping with pong (keepalive)', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', code: '666777' });
    await nextMessage(host, 'joined');

    const pongPromise = nextMessage(host, 'pong');
    send(host, { type: 'ping', ts: Date.now() });
    const pong = await pongPromise;
    expect(pong.type).toBe('pong');
    host.close();
  });

  it('lists active sessions with live viewer counts', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Listed', code: '111000' });
    await nextMessage(host, 'joined');

    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', code: '111000' });
    await nextMessage(viewer, 'joined');
    await nextMessage(host, 'peer-joined');

    const sessions = server.listSessions();
    const session = sessions.find((s) => s.code === '111000');
    expect(session).toBeDefined();
    expect(session!.hostName).toBe('Listed');
    expect(session!.viewers).toBe(1);

    host.close();
    viewer.close();
  });
});
