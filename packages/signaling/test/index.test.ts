import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidSessionCode } from '@stream-screen/core';
import { start, type StreamScreenSignaling } from '../src/index.js';
import { Discovery } from '../src/discovery.js';

describe('start() — discovered hosts carry a valid, connectable code (P2 regression)', () => {
  let handle: StreamScreenSignaling | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.restoreAllMocks();
  });

  it('advertises with a VALID minted session code', async () => {
    // Spy on advertise to capture exactly what is published to mDNS.
    const advertiseSpy = vi
      .spyOn(Discovery.prototype, 'advertise')
      .mockReturnValue(true);

    handle = await start({ port: 0, hostName: 'Test Host' });

    expect(advertiseSpy).toHaveBeenCalledTimes(1);
    const opts = advertiseSpy.mock.calls[0]![0];
    // The bug: advertise was called WITHOUT a code, so the TXT had no code and
    // every discovered host surfaced code:'' (unconnectable).
    expect(typeof opts.code).toBe('string');
    expect(isValidSessionCode(opts.code!)).toBe(true);

    // The handle exposes the same code so the host can join the WS room with it.
    expect(handle.sessionCode).toBe(opts.code);
    expect(isValidSessionCode(handle.sessionCode)).toBe(true);
  });

  it('honours an explicit code option', async () => {
    const advertiseSpy = vi
      .spyOn(Discovery.prototype, 'advertise')
      .mockReturnValue(true);

    handle = await start({ port: 0, hostName: 'Test Host', code: '987654' });

    expect(handle.sessionCode).toBe('987654');
    expect(advertiseSpy.mock.calls[0]![0].code).toBe('987654');
  });
});
