import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRestApi } from '../src/rest-api.js';
import { RemoteDesktopSession } from '../src/session.js';

/**
 * Spin up the Express app on an ephemeral port and return a base URL plus a
 * teardown. Uses the app's own listener so the full middleware chain (CORS +
 * auth) runs exactly as in production.
 */
function listen(app: import('express').Express): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(opts: Parameters<typeof createRestApi>[0] = {}): Promise<{
  url: string;
  authToken: string;
}> {
  const built = createRestApi(opts);
  const { url, server } = await listen(built.app);
  servers.push(server);
  return { url, authToken: built.authToken };
}

describe('REST API security', () => {
  it('generates a non-empty random token when none is configured', async () => {
    const a = createRestApi();
    const b = createRestApi();
    expect(a.authToken.length).toBeGreaterThan(0);
    expect(b.authToken.length).toBeGreaterThan(0);
    // Each instance gets its own token.
    expect(a.authToken).not.toBe(b.authToken);
  });

  it('leaves /health open (no token required)', async () => {
    const { url } = await start({ authToken: 'secret' });
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; authRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.authRequired).toBe(true);
  });

  it('rejects /api/* requests with no bearer token (401)', async () => {
    const { url } = await start({ authToken: 'secret' });
    const res = await fetch(`${url}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects /api/* requests with a wrong bearer token (401)', async () => {
    const { url } = await start({ authToken: 'secret' });
    const res = await fetch(`${url}/api/disconnect`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts /api/* requests with the correct bearer token', async () => {
    const { url, authToken } = await start({ authToken: 'secret' });
    const res = await fetch(`${url}/api/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connected: boolean }).connected).toBe(false);
  });

  it('accepts the token via ?token= query param too', async () => {
    const { url } = await start({ authToken: 'secret' });
    const res = await fetch(`${url}/api/disconnect?token=secret`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('NEVER sends a wildcard Access-Control-Allow-Origin', async () => {
    const { url } = await start({ authToken: 'secret' });
    // A drive-by origin that is NOT allow-listed.
    const res = await fetch(`${url}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reflects only allow-listed origins', async () => {
    const { url } = await start({ authToken: 'secret', allowedOrigins: ['https://trusted.example'] });
    const ok = await fetch(`${url}/health`, {
      headers: { Origin: 'https://trusted.example' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://trusted.example');
    const blocked = await fetch(`${url}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('can disable auth explicitly for trusted setups', async () => {
    const { url } = await start({ requireAuth: false });
    const res = await fetch(`${url}/api/disconnect`, { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('REST API new control routes (auth disabled for brevity)', () => {
  it('control routes exist and error cleanly when not connected', async () => {
    const session = new RemoteDesktopSession();
    const { url } = await start({ session, requireAuth: false });
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Not connected -> 400 with a clear message (route is wired and reachable).
    for (const [path, body] of [
      ['/api/chat', { text: 'hi' }],
      ['/api/quality', { preset: 'high' }],
      ['/api/monitor', { id: 'm1' }],
      ['/api/keys', { keys: ['ctrl', 'c'] }],
      ['/api/combo', { combo: 'ctrl+alt+del' }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status, `${path}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/not connected/i);
    }
    const monitors = await fetch(`${url}/api/monitors`);
    expect(monitors.status).toBe(400);
  });
});
