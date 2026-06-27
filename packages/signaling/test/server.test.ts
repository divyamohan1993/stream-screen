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

  it('rejects a second host on a code that already has a host (host-exists)', async () => {
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Real Host', code: '321321' });
    await nextMessage(host, 'joined');

    const rogue = await connect(port);
    send(rogue, { type: 'join', role: 'host', name: 'Rogue', code: '321321' });
    const err = await nextMessage(rogue, 'error');
    expect(err.message).toBe('host-exists');

    // The advertised host name must NOT have been overwritten by the rogue.
    const session = server.listSessions().find((s) => s.code === '321321');
    expect(session!.hostName).toBe('Real Host');

    host.close();
    rogue.close();
  });

  it('lets a new host reclaim a code once the previous host has left', async () => {
    const host1 = await connect(port);
    send(host1, { type: 'join', role: 'host', name: 'First', code: '555111' });
    await nextMessage(host1, 'joined');
    host1.close();
    // Give the close handler a tick to reap the empty room.
    await new Promise((r) => setTimeout(r, 50));

    const host2 = await connect(port);
    send(host2, { type: 'join', role: 'host', name: 'Second', code: '555111' });
    const joined = await nextMessage(host2, 'joined');
    expect(joined.role).toBe('host');
    host2.close();
  });

  it('rejects a viewer joining a room that has no host yet', async () => {
    // Two viewers race a code with no host: first viewer creates a hostless room
    // implicitly only if allowed — here we ensure a viewer on a never-hosted
    // code is rejected as no-such-session.
    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', code: '424242' });
    const err = await nextMessage(viewer, 'error');
    expect(err.message).toBe('no-such-session');
    viewer.close();
  });

  it('caps simultaneous viewers per room (room-full)', async () => {
    const small = new SignalingServer({ port: 0, heartbeatMs: 0, maxViewersPerRoom: 1 });
    try {
      const p = small.port;
      const host = await connect(p);
      send(host, { type: 'join', role: 'host', code: '909090' });
      await nextMessage(host, 'joined');

      const v1 = await connect(p);
      send(v1, { type: 'join', role: 'viewer', code: '909090' });
      await nextMessage(v1, 'joined');

      const v2 = await connect(p);
      send(v2, { type: 'join', role: 'viewer', code: '909090' });
      const err = await nextMessage(v2, 'error');
      expect(err.message).toBe('room-full');

      host.close();
      v1.close();
      v2.close();
    } finally {
      await small.close();
    }
  });

  it('throttles repeated failed viewer joins (too-many-attempts)', async () => {
    const strict = new SignalingServer({
      port: 0,
      heartbeatMs: 0,
      maxJoinFailures: 3,
      joinFailWindowMs: 60_000,
    });
    try {
      const p = strict.port;
      const ws = await connect(p);
      // 3 wrong-code attempts are answered with no-such-session...
      for (let i = 0; i < 3; i++) {
        send(ws, { type: 'join', role: 'viewer', code: '000001' });
        const err = await nextMessage(ws, 'error');
        // a fresh socket each time would be needed for distinct peers, but the
        // server rejects join before registering a peer, so reuse is fine.
        expect(['no-such-session', 'too-many-attempts']).toContain(err.message);
      }
      // ...the next attempt is throttled.
      send(ws, { type: 'join', role: 'viewer', code: '000001' });
      const err = await nextMessage(ws, 'error');
      expect(err.message).toBe('too-many-attempts');
      ws.close();
    } finally {
      await strict.close();
    }
  });

  it('rejects browser-origin WS handshakes unless allowlisted', async () => {
    const guarded = new SignalingServer({ port: 0, heartbeatMs: 0 });
    try {
      const p = guarded.port;
      // A handshake carrying a (non-allowlisted) Origin must be refused.
      const rejected = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p}`, {
          headers: { origin: 'http://evil.example' },
        });
        ws.once('open', () => reject(new Error('expected handshake to be rejected')));
        ws.once('error', () => resolve());
        ws.once('unexpected-response', () => resolve());
      });
      await rejected;

      // A non-browser client (no Origin) still connects fine.
      const ok = await connect(p);
      send(ok, { type: 'join', role: 'host', code: '787878' });
      await nextMessage(ok, 'joined');
      ok.close();
    } finally {
      await guarded.close();
    }
  });

  it('allows a same-origin browser handshake by default', async () => {
    // Origin host:port matches the Host header (127.0.0.1:<port>) the browser
    // connects to — the legitimate "viewer served from the signaling host" case.
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    send(ws, { type: 'join', role: 'host', code: '343434' });
    await nextMessage(ws, 'joined');
    ws.close();
  });

  it('allows an explicitly allowlisted browser Origin', async () => {
    const allow = new SignalingServer({
      port: 0,
      heartbeatMs: 0,
      allowedOrigins: ['http://localhost:5173'],
    });
    try {
      const p = allow.port;
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${p}`, {
          headers: { origin: 'http://localhost:5173' },
        });
        s.once('open', () => resolve(s));
        s.once('error', reject);
      });
      send(ws, { type: 'join', role: 'host', code: '232323' });
      await nextMessage(ws, 'joined');
      ws.close();
    } finally {
      await allow.close();
    }
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
