import { test, expect, type Page } from '@playwright/test';

/**
 * Connection-consent auth over REAL WebRTC (mode 'prompt').
 *
 * In prompt mode there is no PIN: the host human must Accept each inbound viewer.
 * The handshake still runs P2P over the encrypted control channel (host
 * auth-challenge{mode:'prompt'} -> viewer auth-response{proof:''} -> host
 * auth-result), and the host withholds its media until the operator consents.
 *
 *  - host AUTO-ACCEPTS -> auth-result{ok:true}  -> viewer receives live video.
 *  - host REJECTS      -> auth-result{ok:false} -> viewer denied, NO video.
 *  - host never answers (timeout) -> no verdict  -> viewer denied, NO video
 *    (fail-closed: nothing is granted by default).
 */

async function bootHost(host: Page, code: string, consent: string): Promise<void> {
  await host.goto(`/host-page.html?mode=prompt&consent=${consent}&code=${code}`);
  await expect
    .poll(async () => (await host.evaluate(() => window.__host.getState())).ready)
    .toBe(true);
}

async function bootViewer(viewer: Page, code: string): Promise<void> {
  await viewer.goto(`/viewer-page.html?mode=prompt&code=${code}`);
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).ready)
    .toBe(true);
}

test('prompt mode: host auto-accepts -> viewer receives live video', async ({ browser }) => {
  const code = '880011';
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
    await bootHost(host, code, 'accept');
    await bootViewer(viewer, code);

    // Viewer is challenged in prompt mode (and reports the mode it saw).
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authMode, {
        message: 'viewer should be challenged in prompt mode',
        timeout: 30_000,
      })
      .toBe('prompt');

    // Operator accepts -> verdict ok -> media attached.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authResult, {
        message: 'viewer should be accepted',
        timeout: 30_000,
      })
      .toBe(true);

    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'accepted viewer video width should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    const decoded1 = await viewer.evaluate(() => window.__viewer.getDecodedFrameCount());
    await expect
      .poll(async () => viewer.evaluate(() => window.__viewer.getDecodedFrameCount()), {
        message: 'accepted viewer should keep decoding frames',
        timeout: 30_000,
      })
      .toBeGreaterThan(decoded1);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});

test('prompt mode: host rejects -> viewer denied, NO video (fail-closed)', async ({ browser }) => {
  const code = '880022';
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

  try {
    await bootHost(host, code, 'reject');
    await bootViewer(viewer, code);

    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authResult, {
        message: 'viewer should be rejected',
        timeout: 30_000,
      })
      .toBe(false);

    const hostAuth = await host.evaluate(() => window.__host.getAuthState());
    expect(hostAuth.streamAttached).toBe(false);
    expect(Object.values(hostAuth.authByPeer)).toContain('denied');

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

test('prompt mode: host never answers (timeout) -> no verdict, NO video (fail-closed)', async ({
  browser,
}) => {
  const code = '880033';
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

  try {
    // 'timeout': the host's consent promise never resolves, so it never sends an
    // auth-result. The viewer must stay pending and never receive media.
    await bootHost(host, code, 'timeout');
    await bootViewer(viewer, code);

    // The viewer IS challenged and DOES respond (proves the handshake started),
    // so the host has an unsettled session — but no verdict is ever produced.
    await expect
      .poll(
        async () => (await viewer.evaluate(() => window.__viewer.getAuthState())).authChallenged,
        { message: 'viewer should still be challenged in timeout case', timeout: 30_000 },
      )
      .toBe(true);

    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getAuthState())).authAttempts, {
        message: 'host should receive the viewer auth-response',
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);

    // No verdict, no media, ever — over a generous window.
    const after = await viewer.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return {
        auth: window.__viewer.getAuthState(),
        gotTrack: window.__viewer.getState().gotTrack,
        size: window.__viewer.getVideoSize(),
      };
    });
    expect(after.auth.authResult).toBeNull();
    expect(after.gotTrack).toBe(false);
    expect(after.size.width).toBe(0);
    expect(after.size.height).toBe(0);

    const hostAuth = await host.evaluate(() => window.__host.getAuthState());
    expect(hostAuth.streamAttached).toBe(false);
    // The peer stays 'pending' — never resolved to ok/denied.
    expect(Object.values(hostAuth.authByPeer)).not.toContain('ok');
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
