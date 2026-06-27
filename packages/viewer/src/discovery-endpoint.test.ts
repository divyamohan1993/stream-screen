import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent } from '@stream-screen/core';
import { signalingUrlForHost, type DiscoveredHost } from './discovery-client.js';

/**
 * Regression for FINDING A: a discovered mDNS host must be reached via ITS OWN
 * advertised address:port, not the viewer's default (localhost) signaling URL.
 * Otherwise a host on another LAN machine is unreachable (no-such-session).
 */

function host(over: Partial<DiscoveredHost>): DiscoveredHost {
  return { code: '111222', hostName: 'H', createdAt: 0, viewers: 0, port: 8787, ...over };
}

describe('signalingUrlForHost', () => {
  it('builds a ws URL from the advertised address and port', () => {
    expect(signalingUrlForHost(host({ address: '192.168.1.50', port: 8787 }))).toBe(
      'ws://192.168.1.50:8787',
    );
  });

  it('honours a non-default advertised port', () => {
    expect(signalingUrlForHost(host({ address: '10.0.0.7', port: 9000 }))).toBe(
      'ws://10.0.0.7:9000',
    );
  });

  it('returns null when no address is advertised (caller falls back to default)', () => {
    expect(signalingUrlForHost(host({ address: undefined }))).toBeNull();
    expect(signalingUrlForHost(host({ address: '' }))).toBeNull();
  });

  it('brackets IPv6 literals', () => {
    expect(signalingUrlForHost(host({ address: 'fe80::1', port: 8787 }))).toBe(
      'ws://[fe80::1]:8787',
    );
  });
});

// --- Session-level: the threaded URL is the one the SignalingClient connects to.

class FakePeer {
  constructor() {}
  on(): void {}
  async start(): Promise<void> {}
  onControl(_cb: (m: ControlMessage) => void): void {}
  onFileChunk(_cb: (b: ArrayBuffer) => void): void {}
  onInput(_cb: (e: InputEvent) => void): void {}
  sendControl(): void {}
  close(): void {}
}

let constructedUrls: string[] = [];
class FakeSignaling {
  constructor(url: string) {
    constructedUrls.push(url);
  }
  on(): void {}
  async connect(): Promise<void> {}
  join(): void {}
  close(): void {}
}

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return { ...actual, Peer: FakePeer, SignalingClient: FakeSignaling };
});

const { ViewerSession } = await import('./viewer-session.js');

describe('ViewerSession honours the threaded discovered signaling URL', () => {
  beforeEach(() => {
    constructedUrls = [];
  });

  it('connects via the discovered host endpoint (NOT localhost)', async () => {
    const url = signalingUrlForHost(host({ address: '192.168.1.50', port: 8787 }))!;
    const session = new ViewerSession({ code: '111222', signalingUrl: url });
    await session.connect();
    expect(constructedUrls).toContain('ws://192.168.1.50:8787');
    expect(constructedUrls.some((u) => u.includes('localhost'))).toBe(false);
  });
});
