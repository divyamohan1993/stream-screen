import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SignalMessage } from '@stream-screen/core';
import { isValidSessionCode } from '@stream-screen/core';
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

/** Wait until `pred()` is true, polling, with a timeout. */
async function waitFor(pred: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('start() — discovery advertises the codes hosts actually join (P2 truthful model)', () => {
  let handle: StreamScreenSignaling | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.restoreAllMocks();
  });

  it('advertises NOTHING joinable at startup (no placeholder code with no host behind it)', async () => {
    const syncSpy = vi.spyOn(Discovery.prototype, 'syncSessions').mockReturnValue(true);

    handle = await start({ port: 0, hostName: 'Test Host' });

    // Discovery is synced on start, but with no live hosts the advertised set is
    // empty — the old behaviour minted+advertised a placeholder code that no
    // host had joined, yielding 'no-such-session' on connect.
    expect(syncSpy).toHaveBeenCalled();
    const lastCall = syncSpy.mock.calls.at(-1)!;
    expect(lastCall[0]).toEqual([]);
  });

  it('advertises a host code only after a real host joins that room, and withdraws it on leave', async () => {
    const synced: Array<Array<{ code: string; hostName: string }>> = [];
    vi.spyOn(Discovery.prototype, 'syncSessions').mockImplementation((sessions) => {
      synced.push(sessions.map((s) => ({ code: s.code, hostName: s.hostName })));
      return true;
    });

    handle = await start({ port: 0, hostName: 'Fallback Name' });
    const port = handle.port;

    // No live host yet -> nothing advertised.
    expect(synced.at(-1)).toEqual([]);

    // A real host joins the local signaling server with a concrete code.
    const code = '654321';
    expect(isValidSessionCode(code)).toBe(true);
    const host = await connect(port);
    host.send(
      JSON.stringify({ type: 'join', role: 'host', code, name: 'My Desktop' }),
    );
    await nextMessage(host, 'joined');

    // Discovery must now advertise EXACTLY the code that host joined.
    await waitFor(
      () => (synced.at(-1) ?? []).some((s) => s.code === code),
      'discovery advertises the joined code',
    );
    const live = synced.at(-1)!;
    expect(live).toEqual([{ code, hostName: 'My Desktop' }]);

    // The host leaving makes the room non-joinable -> the code is withdrawn.
    host.close();
    await waitFor(
      () => (synced.at(-1) ?? []).length === 0,
      'discovery withdraws the code after host leaves',
    );
    expect(synced.at(-1)).toEqual([]);
  });

  it('supports multiple concurrent host sessions (one advertised code per live host)', async () => {
    const synced: Array<Array<{ code: string; hostName: string }>> = [];
    vi.spyOn(Discovery.prototype, 'syncSessions').mockImplementation((sessions) => {
      synced.push(sessions.map((s) => ({ code: s.code, hostName: s.hostName })));
      return true;
    });

    handle = await start({ port: 0, hostName: 'Fallback' });
    const port = handle.port;

    const codeA = '111222';
    const codeB = '333444';
    const a = await connect(port);
    a.send(JSON.stringify({ type: 'join', role: 'host', code: codeA, name: 'Host A' }));
    await nextMessage(a, 'joined');
    const b = await connect(port);
    b.send(JSON.stringify({ type: 'join', role: 'host', code: codeB, name: 'Host B' }));
    await nextMessage(b, 'joined');

    await waitFor(() => {
      const codes = (synced.at(-1) ?? []).map((s) => s.code).sort();
      return codes.length === 2 && codes[0] === codeA && codes[1] === codeB;
    }, 'both host codes advertised concurrently');

    a.close();
    b.close();
  });
});
