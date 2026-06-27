import { test, expect, type Page } from '@playwright/test';

/**
 * Access-PIN auth over REAL WebRTC.
 *
 * The host runs in unattended `pin` mode configured with a PIN. It withholds its
 * outbound media until a viewer completes the challenge-response that runs P2P
 * over the encrypted `control` data channel (host auth-challenge -> viewer
 * auth-response{proof} -> host auth-result). The proof is HMAC-SHA256 over the
 * domain tag, both nonces, and the canonical DTLS channel binding both peers
 * derive from the SDP fingerprints (peer.getChannelBinding) — so it is bound to
 * THIS encrypted transport and never leaves the data channel.
 *
 *  - CORRECT PIN  -> auth-result{ok:true}  -> the viewer receives LIVE, decoding
 *                    video (non-zero size + the decoded-frame counter advances).
 *  - WRONG PIN    -> auth-result{ok:false} -> NO video ever arrives (fail-closed).
 */

// Policy-compliant PIN (>=6, not all-same, not strictly sequential).
const HOST_PIN = '428913';

async function bootHost(host: Page, code: string): Promise<void> {
  await host.goto(`/host-page.html?mode=pin&pin=${HOST_PIN}&code=${code}`);
  await expect
    .poll(async () => (await host.evaluate(() => window.__host.getState())).ready)
    .toBe(true);
}

async function bootViewer(viewer: Page, code: string, pin: string): Promise<void> {
  await viewer.goto(`/viewer-page.html?mode=pin&pin=${pin}&code=${code}`);
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).ready)
    .toBe(true);
}

test('pin mode: correct PIN completes the handshake and the viewer receives live video', async ({
  browser,
}) => {
  const code = '770011';
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

  host.on('console', (m) => {
    if (m.type() === 'error') console.log('[host console.error]', m.text());
  });
  viewer.on('console', (m) => {
    if (m.type() === 'error') console.log('[viewer console.error]', m.text());
  });

  try {
    await bootHost(host, code);
    await bootViewer(viewer, code, HOST_PIN);

    // The viewer is challenged over the control channel and replies with a proof.
    await expect
      .poll(
        async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authChallenged,
        { message: 'viewer should receive an auth-challenge', timeout: 30_000 },
      )
      .toBe(true);

    // The host accepts the proof: auth-result{ok:true} on the viewer.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authResult, {
        message: 'viewer should get auth-result ok:true',
        timeout: 30_000,
      })
      .toBe(true);

    // Host marks this peer authorized and only NOW attaches its media.
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getAuthState())).streamAttached, {
        message: 'host should attach media only after auth succeeds',
        timeout: 30_000,
      })
      .toBe(true);

    // The viewer receives an actual, non-zero-size video track ...
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'authorized viewer video width should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).height, {
        message: 'authorized viewer video height should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // ... and live frames keep decoding (RTP keeps flowing after auth).
    const decoded1 = await viewer.evaluate(() => window.__viewer.getDecodedFrameCount());
    await expect
      .poll(async () => viewer.evaluate(() => window.__viewer.getDecodedFrameCount()), {
        message: 'authorized viewer should keep decoding new frames',
        timeout: 30_000,
      })
      .toBeGreaterThan(decoded1);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});

test('pin mode: wrong PIN is rejected (auth-result ok:false) and receives NO video', async ({
  browser,
}) => {
  const code = '770022';
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

  try {
    await bootHost(host, code);
    // Wrong PIN (also policy-compliant so the viewer still produces a proof — the
    // proof is simply over the wrong derived key and must fail verification).
    await bootViewer(viewer, code, '835264');

    // The viewer is challenged and replies; the host must have processed exactly
    // one proof attempt and rejected it.
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getAuthState())).authAttempts, {
        message: 'host should process the wrong-PIN proof attempt',
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);

    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authResult, {
        message: 'viewer should get auth-result ok:false',
        timeout: 30_000,
      })
      .toBe(false);

    // The host must NEVER have attached its media for this rejected viewer.
    const hostAuth = await host.evaluate(() => window.__host.getAuthState());
    expect(hostAuth.streamAttached).toBe(false);
    expect(Object.values(hostAuth.authByPeer)).toContain('denied');

    // Give RTP a generous window to (not) arrive, then assert the viewer never
    // got a track and the video has zero size — fail-closed, no leakage.
    const gotTrack = await viewer.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return window.__viewer.getState().gotTrack;
    });
    expect(gotTrack).toBe(false);

    const size = await viewer.evaluate(() => window.__viewer.getVideoSize());
    expect(size.width).toBe(0);
    expect(size.height).toBe(0);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
