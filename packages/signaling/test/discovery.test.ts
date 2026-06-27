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
