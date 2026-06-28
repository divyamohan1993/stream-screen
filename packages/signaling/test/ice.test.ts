import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import type { SessionInfo, SignalMessage } from '@stream-screen/core';
import { isIceServerList } from '@stream-screen/core';
import { SignalingServer } from '../src/server.js';
import { createRestServer, type RestDeps } from '../src/rest.js';
import { start, type StreamScreenSignaling } from '../src/index.js';
import { Discovery } from '../src/discovery.js';

/** Open a ws client and resolve once connected. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the next message of `type` on a socket. */
function nextMessage(ws: WebSocket, type: SignalMessage['type']): Promise<SignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${type} message`));
    }, 4000);
    const onMsg = (data: Buffer) => {
      const msg = JSON.parse(data.toString('utf8')) as SignalMessage;
      if (msg.type !== type) return;
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

const SAMPLE: RTCIceServer[] = [
  { urls: 'stun:stun.example.com:3478' },
  { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
];

/** Minimal Discovery stub for the REST surface. */
const stubDiscovery = {
  available: false,
  async browse() {
    return [];
  },
} as unknown as Discovery;

const sampleSessions: SessionInfo[] = [
  { code: '123456', hostName: 'PC-A', createdAt: 1, viewers: 0 },
];

describe('SignalingServer — ICE-server distribution on `joined`', () => {
  let server: SignalingServer;

  afterEach(async () => {
    await server.close();
  });

  it('hands the configured iceServers to BOTH host and viewer on their `joined` ack', async () => {
    server = new SignalingServer({ port: 0, heartbeatMs: 0, iceServers: SAMPLE });
    const port = server.port;

    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Host', code: '123456' });
    const hostJoined = await nextMessage(host, 'joined');
    expect(hostJoined.iceServers).toEqual(SAMPLE);
    expect(isIceServerList(hostJoined.iceServers)).toBe(true);

    const viewer = await connect(port);
    send(viewer, { type: 'join', role: 'viewer', name: 'Viewer', code: hostJoined.code! });
    const viewerJoined = await nextMessage(viewer, 'joined');
    // BOTH peers must receive the SAME list so they negotiate against one config.
    expect(viewerJoined.iceServers).toEqual(hostJoined.iceServers);

    host.close();
    viewer.close();
  });

  it('omits iceServers from the `joined` ack when none are configured (LAN-only default)', async () => {
    server = new SignalingServer({ port: 0, heartbeatMs: 0 });
    const port = server.port;

    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Host' });
    const joined = await nextMessage(host, 'joined');
    expect(joined.iceServers).toBeUndefined();
    host.close();
  });

  it('getIceServers() returns a defensive copy; mutating it does not affect what is distributed', async () => {
    server = new SignalingServer({ port: 0, heartbeatMs: 0, iceServers: SAMPLE });
    const got = server.getIceServers();
    expect(got).toEqual(SAMPLE);
    got.push({ urls: 'stun:injected:1' });
    got[0]!.urls = 'stun:tampered:1';
    // A fresh read is unaffected by mutation of a previous copy.
    expect(server.getIceServers()).toEqual(SAMPLE);
  });

  it('a later mutation of the caller-supplied array cannot change what the server distributes', async () => {
    const caller: RTCIceServer[] = [{ urls: 'stun:a:1' }];
    server = new SignalingServer({ port: 0, heartbeatMs: 0, iceServers: caller });
    caller.push({ urls: 'stun:b:2' });
    caller[0]!.urls = 'stun:tampered:1';
    expect(server.getIceServers()).toEqual([{ urls: 'stun:a:1' }]);
  });
});

describe('REST GET /api/ice', () => {
  let rest: Server;
  let port: number;

  function startRest(deps: Partial<RestDeps> = {}): Promise<void> {
    rest = createRestServer({
      listSessions: () => sampleSessions,
      mintCode: () => '654321',
      discovery: stubDiscovery,
      ...deps,
    });
    return new Promise((resolve) => {
      rest.listen(0, () => {
        port = (rest.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => rest.close(() => resolve()));
  });

  it('returns the configured iceServers', async () => {
    await startRest({ iceServers: () => SAMPLE });
    const res = await fetch(`http://127.0.0.1:${port}/api/ice`);
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    expect(body.iceServers).toEqual(SAMPLE);
    expect(isIceServerList(body.iceServers)).toBe(true);
  });

  it('returns an empty list when no provider is configured (LAN-only default)', async () => {
    await startRest();
    const res = await fetch(`http://127.0.0.1:${port}/api/ice`);
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    expect(body.iceServers).toEqual([]);
  });
});

describe('start() — STREAMSCREEN_ICE_SERVERS env wiring', () => {
  let handle: StreamScreenSignaling | undefined;
  const ENV = 'STREAMSCREEN_ICE_SERVERS';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
    // Discovery is irrelevant here; stub it so no mDNS sockets are opened.
    vi.spyOn(Discovery.prototype, 'syncSessions').mockReturnValue(true);
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    vi.restoreAllMocks();
  });

  it('parses the compact env (turn+stun) and surfaces it on `joined` and GET /api/ice', async () => {
    process.env[ENV] =
      'stun:stun.example.com:3478, turn:user:pass@turn.example.com:3478';
    handle = await start({ port: 0, hostName: 'Test Host', disableDiscovery: true });
    const port = handle.port;

    const expected: RTCIceServer[] = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
    ];

    // The joining client's `joined` carries the parsed list.
    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Host' });
    const joined = await nextMessage(host, 'joined');
    expect(joined.iceServers).toEqual(expected);
    host.close();

    // And GET /api/ice returns the same.
    const res = await fetch(`http://127.0.0.1:${port}/api/ice`);
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    expect(body.iceServers).toEqual(expected);
  });

  it('defaults to an empty list (LAN-only) when the env is unset', async () => {
    delete process.env[ENV];
    handle = await start({ port: 0, hostName: 'Test Host', disableDiscovery: true });
    const port = handle.port;

    const host = await connect(port);
    send(host, { type: 'join', role: 'host', name: 'Host' });
    const joined = await nextMessage(host, 'joined');
    expect(joined.iceServers).toBeUndefined();
    host.close();

    const res = await fetch(`http://127.0.0.1:${port}/api/ice`);
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    expect(body.iceServers).toEqual([]);
  });
});
