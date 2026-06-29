import { test, expect } from '@playwright/test';

/**
 * Session recording end to end. Once the viewer is receiving live video, it runs
 * a MediaRecorder over the incoming remote MediaStream for ~1s, stops, and we
 * assert it captured a non-zero number of recorded bytes (a real, downloadable
 * .webm would be the concatenation of these chunks). This proves the received
 * stream is recordable on the viewer.
 */

const code = '880044';

test('viewer records the incoming stream and produces non-empty output', async ({ browser }) => {
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
    await viewer.goto(`/viewer-page.html?code=${code}`);

    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).connectionState, {
        timeout: 30_000,
      })
      .toMatch(/connected|completed/);

    // Need decoded frames before recording is meaningful.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'remote video should decode before recording',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // Start recording the received stream.
    const started = await viewer.evaluate(() => window.__viewer.startRecording());
    expect(started).toBe(true);

    // Record for ~1s. We poll the host frame counter to guarantee real time +
    // live frames pass rather than relying on a bare fixed sleep.
    const f1 = await host.evaluate(() => window.__host.getFrame());
    await expect
      .poll(async () => host.evaluate(() => window.__host.getFrame()), { timeout: 15_000 })
      .toBeGreaterThan(f1 + 30);

    const result = await viewer.evaluate(() => window.__viewer.stopRecording());
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.chunks).toBeGreaterThan(0);

    // The produced blob must be a REAL WebM container, not just non-empty bytes:
    // its first four bytes are the EBML magic 0x1A 0x45 0xDF 0xA3. We read them
    // from the recorded Blob via arrayBuffer() on the viewer page.
    expect(result.head).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
