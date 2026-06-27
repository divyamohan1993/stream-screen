import { test, expect, type Page } from '@playwright/test';

/**
 * System-audio streaming end to end. The host mixes a synthetic audio track
 * (AudioContext oscillator -> MediaStreamDestination) into its canvas
 * captureStream and negotiates it over the same peer connection as the video.
 * We assert the viewer actually receives a *live* audio track on the remote
 * stream, and that the viewer mute/unmute toggle flips the inbound track's
 * enabled flag (the receive-side control a real viewer exposes).
 */

const code = '880011';

async function bringUp(browser: Parameters<Parameters<typeof test>[2]>[0]['browser']) {
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

  // `audio=1` makes the host attach the synthetic system-audio track.
  await host.goto(`/host-page.html?code=${code}&audio=1`);
  await viewer.goto(`/viewer-page.html?code=${code}`);

  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).connectionState, {
      timeout: 30_000,
    })
    .toMatch(/connected|completed/);

  return { hostCtx, viewerCtx, host, viewer };
}

async function audioInfo(viewer: Page) {
  return viewer.evaluate(() => window.__viewer.getAudioTrackInfo());
}

test('viewer receives a live system-audio track from the host', async ({ browser }) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    expect(await host.evaluate(() => window.__hostError ?? null)).toBeNull();

    // The host should report an outbound audio sender exists.
    // (Proven indirectly below by the viewer receiving the track.)

    // Viewer receives at least one audio track and it is live.
    await expect
      .poll(async () => (await audioInfo(viewer)).count, {
        message: 'viewer should receive an audio track',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => (await audioInfo(viewer)).readyState, {
        message: 'received audio track should be live',
        timeout: 30_000,
      })
      .toBe('live');

    // Mute/unmute flips the inbound audio track's enabled flag.
    await viewer.evaluate(() => window.__viewer.setMuted(true));
    await expect.poll(async () => (await audioInfo(viewer)).enabled).toBe(false);

    await viewer.evaluate(() => window.__viewer.setMuted(false));
    await expect.poll(async () => (await audioInfo(viewer)).enabled).toBe(true);

    // The audio track did not knock out the video — both arrived. Poll for the
    // remote video to become ready (metadata populated) rather than sampling
    // once: the size can be 0 for a beat after `connected` while the first
    // frame's dimensions propagate, which is a timing race, not video loss.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'video should survive audio negotiation (remote width > 0)',
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
