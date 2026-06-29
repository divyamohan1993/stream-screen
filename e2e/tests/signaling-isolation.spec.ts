import { test, expect, type Page } from '@playwright/test';

/**
 * Zero-trust signaling proof.
 *
 * The signaling server only relays SDP/ICE; it must NEVER see the access PIN, the
 * PBKDF2 salt/verifier, the per-handshake nonces, or the proof. Those cross ONLY
 * the encrypted DTLS `control` data channel. Here we run a real `pin` auth
 * session and capture EVERY WebSocket frame each peer sends to / receives from
 * the signaling relay (the only thing that transits the server), then assert that
 * none of the captured frames contain any of the secret values.
 *
 * Capture is done by wrapping the page's WebSocket BEFORE any app code runs, via
 * an init script, so it observes the exact bytes the SignalingClient puts on the
 * wire. We assert against the EXACT secret strings each fixture recorded as
 * having emitted on the data channel — not just heuristics — so the test cannot
 * pass by accident if a secret were renamed.
 */

const HOST_PIN = '519274';
const code = '991100';

// Wrap WebSocket so every text frame (sent or received) is recorded. Runs before
// the fixture's module script, which constructs the SignalingClient's socket.
const WS_HOOK = `
  (() => {
    window.__wsFrames = [];
    const Native = window.WebSocket;
    function Wrapped(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      const origSend = ws.send.bind(ws);
      ws.send = (data) => {
        try { if (typeof data === 'string') window.__wsFrames.push({ dir: 'send', data }); } catch {}
        return origSend(data);
      };
      ws.addEventListener('message', (ev) => {
        try { if (typeof ev.data === 'string') window.__wsFrames.push({ dir: 'recv', data: ev.data }); } catch {}
      });
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;
    window.WebSocket = Wrapped;
  })();
`;

async function frames(page: Page): Promise<{ dir: string; data: string }[]> {
  return page.evaluate(() => window.__wsFrames ?? []);
}

test('signaling relay never carries the PIN, salt, verifier, nonces, or proof', async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await host.addInitScript(WS_HOOK);
  await viewer.addInitScript(WS_HOOK);

  host.on('console', (m) => {
    if (m.type() === 'error') console.log('[host console.error]', m.text());
  });
  viewer.on('console', (m) => {
    if (m.type() === 'error') console.log('[viewer console.error]', m.text());
  });

  try {
    await host.goto(`/host-page.html?mode=pin&pin=${HOST_PIN}&code=${code}`);
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getState())).ready)
      .toBe(true);

    await viewer.goto(`/viewer-page.html?mode=pin&pin=${HOST_PIN}&code=${code}`);
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).ready)
      .toBe(true);

    // Drive a COMPLETE, successful pin handshake so the proof actually crosses the
    // data channel (the thing we are proving the server never saw).
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authResult, {
        message: 'pin handshake should complete',
        timeout: 30_000,
      })
      .toBe(true);

    // And real video flows — confirming a genuine, fully-authorized session.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // Collect the exact secret material each fixture emitted on the DATA channel.
    const hostSecrets = await host.evaluate(() => window.__authSecrets ?? {});
    const viewerSecrets = await viewer.evaluate(() => window.__authSecrets ?? {});

    // Sanity: the handshake really produced these secrets (otherwise the test
    // would be vacuously true).
    expect(hostSecrets.salt).toBeTruthy();
    expect(hostSecrets.verifierKey).toBeTruthy();
    expect(hostSecrets.nonceH).toBeTruthy();
    expect(viewerSecrets.nonceV).toBeTruthy();
    expect(viewerSecrets.proof).toBeTruthy();
    expect(viewerSecrets.proof!.length).toBeGreaterThan(0);

    // The full set of secret strings that must NEVER appear on the WS relay.
    const secrets = [
      HOST_PIN,
      hostSecrets.salt,
      hostSecrets.verifierKey,
      hostSecrets.nonceH,
      viewerSecrets.nonceV,
      viewerSecrets.proof,
    ].filter((s): s is string => typeof s === 'string' && s.length > 0);

    const hostFrames = await frames(host);
    const viewerFrames = await frames(viewer);

    // We must actually have captured signaling traffic (join/offer/answer/ice),
    // otherwise the WS hook didn't attach and the test proves nothing.
    expect(hostFrames.length).toBeGreaterThan(0);
    expect(viewerFrames.length).toBeGreaterThan(0);
    const allFrames = [...hostFrames, ...viewerFrames];

    // Every frame should be valid signaling JSON whose type is a relay verb — i.e.
    // SDP/ICE/join/membership, never an auth-* control message.
    const allowedTypes = new Set([
      'join',
      'joined',
      'offer',
      'answer',
      'ice',
      'peer-joined',
      'peer-left',
      'peers',
      'error',
      'leave',
      'pong',
      'ping',
    ]);
    for (const f of allFrames) {
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(f.data);
      } catch {
        parsed = {};
      }
      if (parsed.type) {
        expect(
          allowedTypes.has(parsed.type),
          `unexpected signaling frame type "${parsed.type}": ${f.data}`,
        ).toBe(true);
        expect(parsed.type).not.toMatch(/^auth-/);
      }
    }

    // The core assertion: no captured WS frame contains ANY secret substring.
    for (const f of allFrames) {
      for (const secret of secrets) {
        expect(
          f.data.includes(secret),
          `signaling frame leaked a secret (${f.dir}): ${f.data.slice(0, 200)}`,
        ).toBe(false);
      }
    }

    // Defensive: no frame even mentions the auth control-message discriminants,
    // proving the entire auth exchange stayed off the signaling channel.
    for (const f of allFrames) {
      expect(f.data).not.toContain('auth-challenge');
      expect(f.data).not.toContain('auth-response');
      expect(f.data).not.toContain('"proof"');
      expect(f.data).not.toContain('nonceH');
      expect(f.data).not.toContain('nonceV');
    }
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
