import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionInfo } from '@stream-screen/core';
import { createRestServer, type RestDeps } from '../src/rest.js';
import type { Discovery } from '../src/discovery.js';

/** Minimal Discovery stub: /api/discover/health only touch `available`/`browse`. */
const stubDiscovery = {
  available: false,
  async browse() {
    return [];
  },
} as unknown as Discovery;

const sampleSessions: SessionInfo[] = [
  { code: '123456', hostName: 'PC-A', createdAt: 1, viewers: 2 },
];

function startRest(deps: Partial<RestDeps> = {}): Promise<{ server: Server; port: number }> {
  const server = createRestServer({
    listSessions: () => sampleSessions,
    mintCode: () => '654321',
    discovery: stubDiscovery,
    ...deps,
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe('REST server', () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('redacts session codes for unauthenticated callers', async () => {
    ({ server, port } = await startRest());
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const body = (await res.json()) as SessionInfo[];
    expect(body[0].code).toBe('****56');
    expect(body[0].hostName).toBe('PC-A');
    expect(body[0].viewers).toBe(2);
  });

  it('returns raw codes when a valid bearer token is presented', async () => {
    ({ server, port } = await startRest({ token: 'secret-token' }));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    const body = (await res.json()) as SessionInfo[];
    expect(body[0].code).toBe('123456');
  });

  it('still redacts when the wrong token is presented', async () => {
    ({ server, port } = await startRest({ token: 'secret-token' }));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: 'Bearer wrong' },
    });
    const body = (await res.json()) as SessionInfo[];
    expect(body[0].code).toBe('****56');
  });

  it('sends no Access-Control-Allow-Origin by default', async () => {
    ({ server, port } = await startRest());
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: 'http://evil.example' },
    });
    await res.json();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reflects an allowlisted Origin only', async () => {
    ({ server, port } = await startRest({ allowedOrigins: ['http://good.example'] }));

    const good = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: 'http://good.example' },
    });
    await good.json();
    expect(good.headers.get('access-control-allow-origin')).toBe('http://good.example');

    const bad = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: 'http://evil.example' },
    });
    await bad.json();
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('supports wildcard CORS as an explicit opt-out', async () => {
    ({ server, port } = await startRest({ allowedOrigins: ['*'] }));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: 'http://anything.example' },
    });
    await res.json();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('mints a code over POST /api/code', async () => {
    ({ server, port } = await startRest());
    const res = await fetch(`http://127.0.0.1:${port}/api/code`, { method: 'POST' });
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('654321');
  });
});
