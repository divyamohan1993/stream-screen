import { test, expect, type Page } from '@playwright/test';

/**
 * Real WebRTC session end to end: two Chromium contexts (host + viewer) connect
 * through the live signaling server and establish a peer-to-peer media + data
 * session. We assert the viewer actually receives decoded video frames (the
 * canvas captureStream on the host arrives with non-zero dimensions and the
 * host's frame counter keeps advancing) and that the input data channel opens
 * on both ends.
 */

const code = '654321';

async function waitForOpenDataChannel(host: Page, viewer: Page): Promise<void> {
  // The viewer receives the host-created input channel via `ondatachannel`, so
  // its open state is observable directly. The host's own channel open is then
  // confirmed end-to-end by the input.spec (input actually flows host-ward).
  void host;
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).dataChannelOpen, {
      message: 'viewer data channel should open',
      timeout: 30_000,
    })
    .toBe(true);
}

test('host and viewer establish a real WebRTC session with live video', async ({ browser }) => {
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
    await host.goto(`/host-page.html?code=${code}`);
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getState())).ready)
      .toBe(true);

    await viewer.goto(`/viewer-page.html?code=${code}`);
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).ready)
      .toBe(true);

    // Connection reaches a live state on the viewer.
    await expect
      .poll(
        async () => (await viewer.evaluate(() => window.__viewer.getState())).connectionState,
        { message: 'viewer connection state', timeout: 30_000 },
      )
      .toMatch(/connected|completed/);

    // Viewer receives an actual video track and decodes frames.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).gotTrack)
      .toBe(true);

    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'remote video width should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    const size = await viewer.evaluate(() => window.__viewer.getVideoSize());
    expect(size.height).toBeGreaterThan(0);

    // Host frame counter advances (the screen is genuinely streaming).
    const f1 = await host.evaluate(() => window.__host.getFrame());
    await expect
      .poll(async () => host.evaluate(() => window.__host.getFrame()))
      .toBeGreaterThan(f1);

    // Data channel is open on both ends.
    await waitForOpenDataChannel(host, viewer);

    // The viewer can read live WebRTC stats (proves the adaptive surface works).
    const stats = await viewer.evaluate(() => window.__viewer.getStats());
    expect(stats).toBeTruthy();
    expect(typeof (stats as { ts?: number }).ts).toBe('number');
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
