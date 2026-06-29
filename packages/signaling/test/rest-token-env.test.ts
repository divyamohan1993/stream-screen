import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SignalMessage, SessionInfo } from '@stream-screen/core';
import { start, type StreamScreenSignaling } from '../src/index.js';

/**
 * Regression tests for the "one REST token env var across signaling and AI" fix.
 *
 * The AI client (packages/ai/src/session.ts) reads its bearer token from
 * STREAMSCREEN_TOKEN and presents it to /api/sessions to obtain UN-REDACTED,
 * joinable codes. Before this fix the signaling server only honored
 * STREAMSCREEN_REST_TOKEN, so in the documented single-token setup
 * (operator sets STREAMSCREEN_TOKEN) the server kept redacting codes, the AI
 * dropped them, and list_hosts returned NO usable hosts despite live sessions.
 *
 * These tests drive the real start() path (env -> createRestServer) and assert
 * the token wiring end-to-end over HTTP.
 */

/** Open a ws client and resolve once connected. */
function connectWs(port: number): Promise<WebSocket> {
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
    const onMsg = (data: Buffer): void => {
      const msg = JSON.parse(data.toString('utf8')) as SignalMessage;
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    };
    ws.on('message', onMsg);
  });
}

/** Register a live host room so /api/sessions has a real code to return. */
async function joinHost(port: number, code: string): Promise<WebSocket> {
  const host = await connectWs(port);
  host.send(JSON.stringify({ type: 'join', role: 'host', code, name: 'PC-A' }));
  await nextMessage(host, 'joined');
  return host;
}

async function getSessions(
  port: number,
  bearer?: string,
): Promise<SessionInfo[]> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
  return (await res.json()) as SessionInfo[];
}

describe('start() — REST token env var (STREAMSCREEN_TOKEN canonical, STREAMSCREEN_REST_TOKEN alias)', () => {
  let handle: StreamScreenSignaling | undefined;
  let host: WebSocket | undefined;
  const saved = {
    token: process.env.STREAMSCREEN_TOKEN,
    restToken: process.env.STREAMSCREEN_REST_TOKEN,
  };

  beforeEach(() => {
    delete process.env.STREAMSCREEN_TOKEN;
    delete process.env.STREAMSCREEN_REST_TOKEN;
  });

  afterEach(async () => {
    host?.close();
    host = undefined;
    await handle?.close();
    handle = undefined;
    if (saved.token === undefined) delete process.env.STREAMSCREEN_TOKEN;
    else process.env.STREAMSCREEN_TOKEN = saved.token;
    if (saved.restToken === undefined) delete process.env.STREAMSCREEN_REST_TOKEN;
    else process.env.STREAMSCREEN_REST_TOKEN = saved.restToken;
  });

  it('STREAMSCREEN_TOKEN unredacts /api/sessions for a matching Bearer (the documented AI setup)', async () => {
    process.env.STREAMSCREEN_TOKEN = 'canonical-token';
    handle = await start({ port: 0, hostName: 'Test Host' });
    host = await joinHost(handle.port, '123456');

    const authed = await getSessions(handle.port, 'canonical-token');
    expect(authed[0].code).toBe('123456');
  });

  it('the legacy STREAMSCREEN_REST_TOKEN alias still unredacts for a matching Bearer', async () => {
    process.env.STREAMSCREEN_REST_TOKEN = 'legacy-token';
    handle = await start({ port: 0, hostName: 'Test Host' });
    host = await joinHost(handle.port, '123456');

    const authed = await getSessions(handle.port, 'legacy-token');
    expect(authed[0].code).toBe('123456');
  });

  it('STREAMSCREEN_TOKEN wins when both env vars are set', async () => {
    process.env.STREAMSCREEN_TOKEN = 'canonical-token';
    process.env.STREAMSCREEN_REST_TOKEN = 'legacy-token';
    handle = await start({ port: 0, hostName: 'Test Host' });
    host = await joinHost(handle.port, '123456');

    // The canonical token unredacts...
    const authed = await getSessions(handle.port, 'canonical-token');
    expect(authed[0].code).toBe('123456');

    // ...while the alias value is NOT accepted (canonical takes precedence).
    const aliasAttempt = await getSessions(handle.port, 'legacy-token');
    expect(aliasAttempt[0].code).toBe('****56');
  });

  it('a wrong token still gets redacted codes', async () => {
    process.env.STREAMSCREEN_TOKEN = 'canonical-token';
    handle = await start({ port: 0, hostName: 'Test Host' });
    host = await joinHost(handle.port, '123456');

    const wrong = await getSessions(handle.port, 'nope');
    expect(wrong[0].code).toBe('****56');
  });

  it('an absent token still gets redacted codes', async () => {
    process.env.STREAMSCREEN_TOKEN = 'canonical-token';
    handle = await start({ port: 0, hostName: 'Test Host' });
    host = await joinHost(handle.port, '123456');

    const anon = await getSessions(handle.port);
    expect(anon[0].code).toBe('****56');
  });

  it('with NO token env var set, /api/sessions is always redacted', async () => {
    handle = await start({ port: 0, hostName: 'Test Host' });
    host = await joinHost(handle.port, '123456');

    const anon = await getSessions(handle.port, 'anything');
    expect(anon[0].code).toBe('****56');
  });
});
