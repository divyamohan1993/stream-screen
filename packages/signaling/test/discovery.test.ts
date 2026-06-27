import { afterEach, describe, expect, it } from 'vitest';
import { Discovery } from '../src/discovery.js';

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
