import { test, expect, type Page } from '@playwright/test';

/**
 * Per-connection media ISOLATION over REAL WebRTC (P1-B), plus per-connection
 * control-channel readiness (P1-A).
 *
 * One host + TWO viewers join the same session over the real signaling server
 * and establish real RTCPeerConnections. The host attaches its screen-capture
 * media to ONLY viewer A, via the per-connection primitive
 * `peer.attachStreamTo(remoteIdOfA, stream)`. It NEVER calls the session-wide
 * `peer.attachStream(stream)`.
 *
 * We then assert, end to end over real media:
 *   - viewer A receives a LIVE video track: non-zero videoWidth/Height and the
 *     decoded-frame counter advances (RTP keeps flowing).
 *   - viewer B receives NO video at all: no `track` event, zero-size video.
 *
 * This proves `attachStreamTo` does NOT leak onto the other existing connection
 * and that the session-wide replay-to-new path does NOT run — exactly the P1-B
 * regression. The prior auth e2e used the session-wide attach and so could not
 * catch a per-connection leak; this one targets it directly.
 *
 * We also assert P1-A: the host's `onControlOpen` fired once PER connection (two
 * distinct remoteIds), since that per-viewer edge is the only moment the host
 * could deliver per-viewer control frames.
 */

async function bootHostIsolate(host: Page, code: string): Promise<void> {
  // 'isolate' mode: the host never session-wide-attaches; the spec drives
  // per-viewer attachStreamTo. No auth handshake runs in this mode.
  await host.goto(`/host-page.html?mode=isolate&code=${code}`);
  await expect
    .poll(async () => (await host.evaluate(() => window.__host.getState())).ready)
    .toBe(true);
}

async function bootViewer(viewer: Page, code: string, label: string): Promise<void> {
  await viewer.goto(`/viewer-page.html?code=${code}&label=${label}`);
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).ready)
    .toBe(true);
}

test('host attachStreamTo isolates media to one viewer; the other gets nothing', async ({
  browser,
}) => {
  const code = '880011';
  const hostCtx = await browser.newContext();
  const viewerACtx = await browser.newContext();
  const viewerBCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewerA = await viewerACtx.newPage();
  const viewerB = await viewerBCtx.newPage();

  host.on('console', (m) => {
    if (m.type() === 'error') console.log('[host console.error]', m.text());
  });
  viewerA.on('console', (m) => {
    if (m.type() === 'error') console.log('[viewerA console.error]', m.text());
  });
  viewerB.on('console', (m) => {
    if (m.type() === 'error') console.log('[viewerB console.error]', m.text());
  });

  try {
    await bootHostIsolate(host, code);
    // Bring up BOTH viewers BEFORE any media is attached, so both connections
    // (and their control channels) exist. A session-wide attach would then
    // replay onto BOTH — which is exactly what must NOT happen.
    await bootViewer(viewerA, code, 'A');
    await bootViewer(viewerB, code, 'B');

    // Wait until the host knows BOTH viewers' labels (each announced over its own
    // now-open control channel — itself proof that both control channels opened).
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getKnownViewerLabels())).sort(), {
        message: 'host should learn both viewer labels over their control channels',
        timeout: 30_000,
      })
      .toEqual(['A', 'B']);

    // P1-A: onControlOpen fired once PER connection — two DISTINCT remoteIds.
    const opened = await host.evaluate(() => window.__host.getControlOpenEvents());
    expect(new Set(opened).size).toBe(2);

    // P1-B: attach the host stream to ONLY viewer A's connection. No session-wide
    // attachStream is ever called in 'isolate' mode.
    const attached = await host.evaluate(() => window.__host.attachStreamToLabel('A'));
    expect(attached).toBe(true);

    // Viewer A receives a LIVE, non-zero-size video track ...
    await expect
      .poll(async () => (await viewerA.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'viewer A video width should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await viewerA.evaluate(() => window.__viewer.getVideoSize())).height, {
        message: 'viewer A video height should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // ... and frames keep decoding (RTP keeps flowing to A).
    const decodedA1 = await viewerA.evaluate(() => window.__viewer.getDecodedFrameCount());
    await expect
      .poll(async () => viewerA.evaluate(() => window.__viewer.getDecodedFrameCount()), {
        message: 'viewer A should keep decoding new frames',
        timeout: 30_000,
      })
      .toBeGreaterThan(decodedA1);

    // Viewer B must NEVER receive media: give RTP a generous window to (not)
    // arrive — the session-wide replay this test guards against would surface a
    // track here — then assert no track and zero-size video. Fail-closed.
    const bGotTrack = await viewerB.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return window.__viewer.getState().gotTrack;
    });
    expect(bGotTrack).toBe(false);

    const bSize = await viewerB.evaluate(() => window.__viewer.getVideoSize());
    expect(bSize.width).toBe(0);
    expect(bSize.height).toBe(0);

    // Viewer A is unaffected by B's connection — still live (no regression).
    expect((await viewerA.evaluate(() => window.__viewer.getVideoSize())).width).toBeGreaterThan(0);
  } finally {
    await hostCtx.close();
    await viewerACtx.close();
    await viewerBCtx.close();
  }
});

test('a viewer that joins AFTER an attach does not auto-receive the replayed stream', async ({
  browser,
}) => {
  const code = '880022';
  const hostCtx = await browser.newContext();
  const viewerACtx = await browser.newContext();
  const viewerBCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewerA = await viewerACtx.newPage();
  const viewerB = await viewerBCtx.newPage();

  try {
    await bootHostIsolate(host, code);
    await bootViewer(viewerA, code, 'A');
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getKnownViewerLabels())).sort(), {
        timeout: 30_000,
      })
      .toEqual(['A']);

    // Attach media to A FIRST. A session-wide attach would store localStream and
    // replay it onto any LATER connection; attachStreamTo must not.
    expect(await host.evaluate(() => window.__host.attachStreamToLabel('A'))).toBe(true);
    await expect
      .poll(async () => (await viewerA.evaluate(() => window.__viewer.getVideoSize())).width, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // NOW a second viewer joins, after the attach.
    await bootViewer(viewerB, code, 'B');
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getKnownViewerLabels())).sort(), {
        timeout: 30_000,
      })
      .toEqual(['A', 'B']);

    // Viewer B must receive NOTHING despite joining after A's media was attached
    // (no auto-replay-to-new). Generous window, then assert no track / zero size.
    const bGotTrack = await viewerB.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return window.__viewer.getState().gotTrack;
    });
    expect(bGotTrack).toBe(false);
    const bSize = await viewerB.evaluate(() => window.__viewer.getVideoSize());
    expect(bSize.width).toBe(0);
    expect(bSize.height).toBe(0);

    // When the host explicitly attaches to B too, IT (and only then) gets media.
    expect(await host.evaluate(() => window.__host.attachStreamToLabel('B'))).toBe(true);
    await expect
      .poll(async () => (await viewerB.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'viewer B receives media only after its own per-connection attach',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  } finally {
    await hostCtx.close();
    await viewerACtx.close();
    await viewerBCtx.close();
  }
});
