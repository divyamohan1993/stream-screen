import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from 'bonjour-service';
import { isValidSessionCode } from '@stream-screen/core';
import { Discovery, serviceToHost } from '../src/discovery.js';

describe('Discovery (mDNS, best-effort)', () => {
  let disc: Discovery;

  afterEach(() => {
    disc?.destroy();
  });

  it('advertise + browse never throw, even where multicast is blocked', async () => {
    disc = new Discovery();

    // advertise() returns a boolean and must not throw regardless of network.
    const advertised = disc.advertise({ hostName: 'Test Host', port: 8787, code: '123456' });
    expect(typeof advertised).toBe('boolean');

    // browse() always resolves to an array (possibly empty in sandboxes).
    const hosts = await disc.browse({ timeoutMs: 300 });
    expect(Array.isArray(hosts)).toBe(true);
  });

  it('browse returns [] quickly when mDNS is unavailable, without rejecting', async () => {
    disc = new Discovery();
    const hosts = await disc.browse({ timeoutMs: 200 });
    expect(Array.isArray(hosts)).toBe(true);
    // Every entry, if any, must look like a DiscoveredHost.
    for (const h of hosts) {
      expect(typeof h.port).toBe('number');
      expect(typeof h.hostName).toBe('string');
    }
  });

  it('exposes an `available` flag and destroy() is idempotent', () => {
    disc = new Discovery();
    expect(typeof disc.available).toBe('boolean');
    disc.unadvertise();
    disc.destroy();
    disc.destroy();
    expect(true).toBe(true);
  });
});

describe('serviceToHost (TXT code propagation, P2 regression)', () => {
  /** Build a fake Bonjour service/TXT record as the browser callback would see it. */
  function fakeService(txt: Record<string, string>): Service {
    return {
      name: 'StreamScreen @ Test Host',
      type: 'streamscreen',
      protocol: 'tcp',
      port: 8787,
      addresses: ['192.168.1.42'],
      txt,
    } as unknown as Service;
  }

  it('surfaces a VALID session code from the TXT record', () => {
    const code = '482913';
    const host = serviceToHost(fakeService({ host: 'Test Host', code }));

    expect(host).toBeDefined();
    // The bug: serviceToHost yielded code:'' so the viewer rejected onConnect('').
    expect(host!.code).toBe(code);
    expect(isValidSessionCode(host!.code)).toBe(true);
    expect(host!.hostName).toBe('Test Host');
    expect(host!.address).toBe('192.168.1.42');
    expect(host!.port).toBe(8787);
  });

  it('advertise() is invoked with the session code, which reaches the TXT record', () => {
    // Drive a fake Bonjour through Discovery so we assert the published TXT carries
    // the code end-to-end (advertise -> publish txt -> serviceToHost).
    const code = '730264';
    let publishedTxt: Record<string, string> | undefined;
    const publishSpy = vi.fn((opts: { txt: Record<string, string> }) => {
      publishedTxt = opts.txt;
      return { on: vi.fn(), stop: vi.fn() };
    });

    const disc = new Discovery();
    // Inject a fake Bonjour instance so the test does not depend on multicast.
    (disc as unknown as { bonjour: unknown; failed: boolean }).bonjour = {
      publish: publishSpy,
    };
    (disc as unknown as { failed: boolean }).failed = false;

    const ok = disc.advertise({ hostName: 'Test Host', port: 8787, code });
    expect(ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishedTxt).toBeDefined();
    expect(publishedTxt!.code).toBe(code);

    // The published TXT, fed back through serviceToHost, yields a connectable code.
    const host = serviceToHost(fakeService(publishedTxt!));
    expect(host!.code).toBe(code);
    expect(isValidSessionCode(host!.code)).toBe(true);
  });
});

describe('syncSessions (advertise the codes hosts actually joined — truthful model)', () => {
  /**
   * A fake Bonjour that records every publish() and lets us stop() services so
   * the test can assert the advertised set tracks the live host sessions.
   */
  function fakeBonjour() {
    const published: Array<{
      txt: Record<string, string>;
      name: string;
      port: number;
      stopped: boolean;
      service: { on: () => void; stop: () => void };
    }> = [];
    const bonjour = {
      publish(opts: { txt: Record<string, string>; name: string; port: number }) {
        const entry = {
          txt: opts.txt,
          name: opts.name,
          port: opts.port,
          stopped: false,
          service: {
            on: () => {},
            stop: () => {
              entry.stopped = true;
            },
          },
        };
        published.push(entry);
        return entry.service;
      },
    };
    return { bonjour, published };
  }

  function inject(disc: Discovery, bonjour: unknown): void {
    (disc as unknown as { bonjour: unknown; failed: boolean }).bonjour = bonjour;
    (disc as unknown as { failed: boolean }).failed = false;
  }

  it('advertises a code only after a host joined it, and that code is connectable via serviceToHost', () => {
    const { bonjour, published } = fakeBonjour();
    const disc = new Discovery();
    inject(disc, bonjour);

    // No live host sessions -> nothing joinable is advertised.
    expect(disc.syncSessions([], 8787)).toBe(true);
    expect(published).toHaveLength(0);

    // A host has actually joined code X on the signaling server.
    const code = '482913';
    disc.syncSessions([{ code, hostName: 'Test Host' }], 8787);
    expect(published).toHaveLength(1);
    expect(published[0]!.txt.code).toBe(code);
    expect(published[0]!.port).toBe(8787);

    // The advertised TXT, read back as a discovered host, yields code X with a
    // valid (connectable) session code — i.e. discovery maps to a joinable room.
    const host = serviceToHost({
      name: published[0]!.name,
      type: 'streamscreen',
      protocol: 'tcp',
      port: published[0]!.port,
      addresses: ['192.168.1.7'],
      txt: published[0]!.txt,
    } as unknown as Service);
    expect(host!.code).toBe(code);
    expect(isValidSessionCode(host!.code)).toBe(true);
    expect(host!.hostName).toBe('Test Host');

    disc.destroy();
  });

  it('withdraws a code when its host leaves (re-sync without that session)', () => {
    const { bonjour, published } = fakeBonjour();
    const disc = new Discovery();
    inject(disc, bonjour);

    const code = '730264';
    disc.syncSessions([{ code, hostName: 'Test Host' }], 8787);
    expect(published).toHaveLength(1);
    expect(published[0]!.stopped).toBe(false);

    // The host left -> live sessions is now empty -> the advertisement is stopped.
    disc.syncSessions([], 8787);
    expect(published[0]!.stopped).toBe(true);

    disc.destroy();
  });

  it('supports multiple concurrent host sessions, one advertisement per live code', () => {
    const { bonjour, published } = fakeBonjour();
    const disc = new Discovery();
    inject(disc, bonjour);

    disc.syncSessions(
      [
        { code: '111222', hostName: 'Host A' },
        { code: '333444', hostName: 'Host B' },
      ],
      8787,
    );
    expect(published.map((p) => p.txt.code).sort()).toEqual(['111222', '333444']);

    // Re-syncing the same set is idempotent: no duplicate publishes.
    disc.syncSessions(
      [
        { code: '111222', hostName: 'Host A' },
        { code: '333444', hostName: 'Host B' },
      ],
      8787,
    );
    expect(published).toHaveLength(2);

    // One host leaves: exactly its advertisement is withdrawn, the other stays.
    disc.syncSessions([{ code: '111222', hostName: 'Host A' }], 8787);
    const a = published.find((p) => p.txt.code === '111222')!;
    const b = published.find((p) => p.txt.code === '333444')!;
    expect(a.stopped).toBe(false);
    expect(b.stopped).toBe(true);

    disc.destroy();
  });

  it('never advertises a session whose code is not a valid 6-9 digit code', () => {
    const { bonjour, published } = fakeBonjour();
    const disc = new Discovery();
    inject(disc, bonjour);

    disc.syncSessions(
      [
        { code: '', hostName: 'No Code' },
        { code: 'abc', hostName: 'Bad Code' },
        { code: '12345', hostName: 'Too Short' },
        { code: '123456', hostName: 'Good' },
      ],
      8787,
    );
    expect(published.map((p) => p.txt.code)).toEqual(['123456']);

    disc.destroy();
  });

  it('is a graceful no-op when multicast is unavailable', () => {
    const disc = new Discovery();
    // Force the mDNS stack into the unavailable state.
    (disc as unknown as { failed: boolean }).failed = true;
    expect(disc.syncSessions([{ code: '123456', hostName: 'Host' }], 8787)).toBe(false);
    disc.destroy();
  });
});
