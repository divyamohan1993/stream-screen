/**
 * Regression tests for {@link RemoteDesktopSession.listHosts}.
 *
 * Before the fix, list_hosts sent a WebSocket `hosts` request that the signaling
 * server never handles, so it always timed out and returned []. These tests prove
 * list_hosts now queries the signaling REST API (`/api/discover`, falling back to
 * `/api/sessions`) via global `fetch`, returning the real host list when sessions
 * exist — without ever opening a WebSocket.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidSessionCode } from '@stream-screen/core';
import { RemoteDesktopSession, deriveSignalingHttpUrl } from '../src/session.js';
import { dispatchTool } from '../src/mcp-server.js';

/** Build a Response-like object for a mocked fetch. */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deriveSignalingHttpUrl', () => {
  it('maps ws:// to http:// and wss:// to https:// (port preserved, path stripped)', () => {
    expect(deriveSignalingHttpUrl('ws://192.168.1.5:8787')).toBe('http://192.168.1.5:8787');
    expect(deriveSignalingHttpUrl('wss://host:8787/signal')).toBe('https://host:8787');
    expect(deriveSignalingHttpUrl('ws://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
  });
});

describe('RemoteDesktopSession.listHosts (REST-backed)', () => {
  it('returns discovered hosts from /api/discover (non-empty when sessions exist)', async () => {
    const discovered = [
      { code: '123456', hostName: 'office-pc', address: '192.168.1.5', port: 8787, viewers: 0, createdAt: 1 },
      { code: '987654', hostName: 'laptop', port: 8787, viewers: 1, createdAt: 2 },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/discover')) return jsonResponse(discovered);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    const hosts = await session.listHosts();

    // Proves it no longer times out to [].
    expect(hosts).toEqual([
      { code: '123456', name: 'office-pc' },
      { code: '987654', name: 'laptop' },
    ]);
    // Discover was queried against the derived HTTP base URL.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/discover',
      expect.objectContaining({ method: 'GET' }),
    );
    // Never falls through to /api/sessions when discover has results.
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions',
      expect.anything(),
    );
  });

  it('falls back to /api/sessions when /api/discover is empty', async () => {
    const sessions = [{ code: '555111', hostName: 'desktop', viewers: 2, createdAt: 3 }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/discover')) return jsonResponse([]);
      if (url.endsWith('/api/sessions')) return jsonResponse(sessions);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    const hosts = await session.listHosts();

    expect(hosts).toEqual([{ code: '555111', name: 'desktop' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('honors an explicit signalingHttpUrl override', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ code: '111222', hostName: 'h', viewers: 0, createdAt: 0 }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const session = new RemoteDesktopSession({
      signalingUrl: 'ws://127.0.0.1:8787',
      signalingHttpUrl: 'http://10.0.0.2:9000',
    });
    await session.listHosts();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.0.2:9000/api/discover',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('skips records without a usable code and defaults the name to "host"', async () => {
    const discovered = [
      { hostName: 'no-code' }, // dropped: no code
      { code: '424242' }, // kept: name defaults to "host"
    ];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(discovered)));

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    expect(await session.listHosts()).toEqual([{ code: '424242', name: 'host' }]);
  });

  it('returns [] gracefully on a network error (does not throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    await expect(session.listHosts()).resolves.toEqual([]);
  });

  it('returns [] on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([], false)));
    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    await expect(session.listHosts()).resolves.toEqual([]);
  });

  it('DROPS a redacted /api/sessions code when no token is configured (P2)', async () => {
    // mDNS discovery is empty/unavailable, so list_hosts falls back to
    // /api/sessions. The REST server redacts codes for unauthenticated callers
    // (e.g. "****56"). Such a code fails isValidSessionCode and would be rejected
    // by connect(), so list_hosts must NOT return it.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/discover')) return jsonResponse([]);
      if (url.endsWith('/api/sessions')) {
        return jsonResponse([{ code: '****56', hostName: 'redacted-host', viewers: 1, createdAt: 9 }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    const hosts = await session.listHosts();

    // The redacted, unusable code is dropped — no unusable codes returned.
    expect(hosts).toEqual([]);
    // Unauthenticated fallback request carried no Authorization header.
    const sessionsCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/sessions'),
    );
    expect(sessionsCall).toBeDefined();
    const sentHeaders = (sessionsCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(sentHeaders?.authorization).toBeUndefined();
  });

  it('passes the bearer token to /api/sessions and returns the UNREDACTED code (P2)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/discover')) return jsonResponse([]);
      if (url.endsWith('/api/sessions')) {
        // An authorized caller receives the full, joinable code.
        return jsonResponse([{ code: '778856', hostName: 'desk', viewers: 1, createdAt: 9 }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new RemoteDesktopSession({
      signalingUrl: 'ws://127.0.0.1:8787',
      token: 's3cret',
    });
    const hosts = await session.listHosts();

    expect(hosts).toEqual([{ code: '778856', name: 'desk' }]);
    expect(isValidSessionCode(hosts[0]!.code)).toBe(true);

    // The token was presented as a bearer header on the /api/sessions request.
    const sessionsCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/sessions'),
    );
    const sentHeaders = (sessionsCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(sentHeaders?.authorization).toBe('Bearer s3cret');
  });

  it('returns a valid /api/discover host as-is (full LAN code, no token needed) (P2)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/discover')) {
        return jsonResponse([{ code: '654321', hostName: 'lan-pc', viewers: 0, createdAt: 1 }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    const hosts = await session.listHosts();

    expect(hosts).toEqual([{ code: '654321', name: 'lan-pc' }]);
    expect(isValidSessionCode(hosts[0]!.code)).toBe(true);
    // /api/discover is open: no Authorization header is sent.
    const discoverCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/discover'),
    );
    const sentHeaders = (discoverCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(sentHeaders?.authorization).toBeUndefined();
    // Never falls through to /api/sessions when discover has usable results.
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions',
      expect.anything(),
    );
  });

  it('list_hosts MCP tool surfaces the REST hosts as JSON', async () => {
    const discovered = [{ code: '123456', hostName: 'office-pc', viewers: 0, createdAt: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(discovered)));

    const session = new RemoteDesktopSession({ signalingUrl: 'ws://127.0.0.1:8787' });
    const res = await dispatchTool(session, 'list_hosts', {});
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual([{ code: '123456', name: 'office-pc' }]);
  });
});
