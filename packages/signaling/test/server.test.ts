import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SignalMessage } from '@stream-screen/core';
import { SignalingServer, generateCode } from '../src/server.js';

/** Open a ws client and resolve once connected. */
function connect(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
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

  it('keys the join throttle on the TCP peer, IGNORING spoofed X-Forwarded-For (default)', async () => {
    // Default config: trustProxy is OFF. An attacker rotating X-Forwarded-For on
    // every connection shares one real socket.remoteAddress (127.0.0.1), so the
    // throttle MUST count them as the SAME source and still reach the cap.
    const strict = new SignalingServer({
      port: 0,
      heartbeatMs: 0,
      maxJoinFailures: 3,
      joinFailWindowMs: 60_000,
    });
    try {
      const p = strict.port;
      // 3 failed joins, each from a connection carrying a DIFFERENT forged XFF.
      for (let i = 0; i < 3; i++) {
        const ws = await connect(p, { 'x-forwarded-for': `203.0.113.${i}` });
        send(ws, { type: 'join', role: 'viewer', code: '000001' });
        const err = await nextMessage(ws, 'error');
        expect(['no-such-session', 'too-many-attempts']).toContain(err.message);
        ws.close();
      }
      // A 4th connection with yet another distinct forged XFF must STILL be
      // throttled, because the XFF is ignored and the socket peer is the key.
      const ws = await connect(p, { 'x-forwarded-for': '203.0.113.99' });
      send(ws, { type: 'join', role: 'viewer', code: '000001' });
      const err = await nextMessage(ws, 'error');
      expect(err.message).toBe('too-many-attempts');
      ws.close();
    } finally {
      await strict.close();
    }
  });

  it('honors left-most X-Forwarded-For per source when trustProxy is enabled', async () => {
    // trustProxy ON: the server sits behind a trusted reverse proxy, so distinct
    // X-Forwarded-For client addresses are distinct throttle keys. Repeated
    // failures under ONE XFF reach the cap, while a DIFFERENT XFF still has a
    // fresh budget — proving XFF is honored as the key.
    const proxied = new SignalingServer({
      port: 0,
      heartbeatMs: 0,
      maxJoinFailures: 3,
      joinFailWindowMs: 60_000,
      trustProxy: true,
    });
    try {
      const p = proxied.port;
      const attacker = '198.51.100.7';
      // Exhaust attacker's budget across 3 separate connections (same XFF).
      for (let i = 0; i < 3; i++) {
        const ws = await connect(p, { 'x-forwarded-for': attacker });
        send(ws, { type: 'join', role: 'viewer', code: '000001' });
        const err = await nextMessage(ws, 'error');
        expect(['no-such-session', 'too-many-attempts']).toContain(err.message);
        ws.close();
      }
      // The 4th attempt under the SAME XFF is throttled.
      const blocked = await connect(p, { 'x-forwarded-for': attacker });
      send(blocked, { type: 'join', role: 'viewer', code: '000001' });
      expect((await nextMessage(blocked, 'error')).message).toBe('too-many-attempts');
      blocked.close();

      // A DIFFERENT XFF is a different source -> NOT throttled (gets the oracle
      // 'no-such-session' rather than 'too-many-attempts').
      const fresh = await connect(p, { 'x-forwarded-for': '198.51.100.250' });
      send(fresh, { type: 'join', role: 'viewer', code: '000001' });
      expect((await nextMessage(fresh, 'error')).message).toBe('no-such-session');
      fresh.close();
    } finally {
      await proxied.close();
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

  it('allows the documented Vite dev viewer origin (:5173) by default', async () => {
    // FINDING A regression: the viewer dev server runs on :5173 while the client
    // connects to the signaling port. That Origin shares the server's host but
    // differs in port, and must be accepted by the DEFAULT policy (no allowlist),
    // otherwise the documented dev flow is broken without env config.
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: 'http://127.0.0.1:5173' },
      });
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    send(ws, { type: 'join', role: 'host', code: '517351' });
    await nextMessage(ws, 'joined');
    ws.close();
  });

  it('allows localhost on any port by default', async () => {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: 'http://localhost:5173' },
      });
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    send(ws, { type: 'join', role: 'host', code: '600600' });
    await nextMessage(ws, 'joined');
    ws.close();
  });

  it('allows a private LAN-IP origin on any port by default', async () => {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: 'http://192.168.1.50:5173' },
      });
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    send(ws, { type: 'join', role: 'host', code: '192192' });
    await nextMessage(ws, 'joined');
    ws.close();
  });

  it('allows a no-Origin (native) client by default', async () => {
    // The default `connect` helper sends no Origin header — a native client.
    const ws = await connect(port);
    send(ws, { type: 'join', role: 'host', code: '770077' });
    await nextMessage(ws, 'joined');
    ws.close();
  });

  it('rejects an unrelated public Origin by default', async () => {
    const rejected = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: 'https://evil.example' },
      });
      ws.once('open', () => reject(new Error('expected handshake to be rejected')));
      ws.once('error', () => resolve());
      ws.once('unexpected-response', () => resolve());
    });
    await rejected;
  });

  it('honours STREAMSCREEN_ALLOWED_ORIGINS override (allowlist takes precedence)', async () => {
    // When an explicit allowlist is set it takes precedence over the default LAN
    // policy: a LAN/loopback Origin NOT on the list is rejected, while the listed
    // Origin is accepted.
    const allow = new SignalingServer({
      port: 0,
      heartbeatMs: 0,
      allowedOrigins: ['https://trusted.example'],
    });
    try {
      const p = allow.port;

      // Listed Origin: accepted.
      const ok = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${p}`, {
          headers: { origin: 'https://trusted.example' },
        });
        s.once('open', () => resolve(s));
        s.once('error', reject);
      });
      send(ok, { type: 'join', role: 'host', code: '848484' });
      await nextMessage(ok, 'joined');
      ok.close();

      // A LAN Origin that the default policy WOULD allow is now rejected, proving
      // the explicit allowlist overrides the default.
      const rejected = new Promise<void>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${p}`, {
          headers: { origin: 'http://192.168.1.5:5173' },
        });
        s.once('open', () => reject(new Error('expected handshake to be rejected')));
        s.once('error', () => resolve());
        s.once('unexpected-response', () => resolve());
      });
      await rejected;
    } finally {
      await allow.close();
    }
  });

  it('drops a hostless room from listSessions when the host leaves, notifies viewers, and rejects a new viewer', async () => {
    // FINDING B regression: after the host disconnects with viewers still
    // present, the room must NOT linger in listSessions() (a dead code fed to
    // discovery/REST), remaining viewers must be told the host departed, and a
    // NEW viewer using that code must get no-such-session rather than silently
    // attaching to a dead room.
    const changes: number[] = [];
    server.on('sessions-changed', (sessions) => changes.push(sessions.length));

    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Reapable', code: '262626' });
    await nextMessage(host, 'joined');

    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', code: '262626' });
    await nextMessage(viewer, 'joined');
    await nextMessage(host, 'peer-joined');

    // One live session right now.
    expect(server.listSessions().some((s) => s.code === '262626')).toBe(true);
    expect(server.listSessions()).toHaveLength(1);

    // Remaining viewer is notified the host disconnected when the host leaves.
    const hostGone = nextMessage(viewer, 'error');
    host.close();
    const err = await hostGone;
    expect(err.message).toBe('host-disconnected');

    // Give the close/reap a tick.
    await new Promise((r) => setTimeout(r, 50));

    // The hostless room no longer appears in listSessions().
    expect(server.listSessions().some((s) => s.code === '262626')).toBe(false);
    // sessions-changed fired on host departure (last snapshot has no room).
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.at(-1)).toBe(0);

    // A NEW viewer joining the now-dead code is handled as no-such-session.
    const late = await connect(port);
    send(late, { type: 'join', role: 'viewer', code: '262626' });
    const lateErr = await nextMessage(late, 'error');
    expect(lateErr.message).toBe('no-such-session');
    late.close();
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
