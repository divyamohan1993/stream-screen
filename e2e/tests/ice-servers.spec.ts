import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * "Connect from anywhere" ICE plumbing — does NOT regress the LAN/loopback path.
 *
 * The opt-in feature adds configurable ICE servers (STUN for hole-punching, a
 * self-hosted TURN relay for strict/CGNAT networks) to every RTCPeerConnection,
 * distributed once by the signaling server so both peers match. This suite
 * proves the wiring is real AND harmless:
 *
 *  1. STUN-ONLY supplied to BOTH peers — the same two-Chromium real WebRTC
 *     session from session.spec.ts STILL connects and streams live, decoded
 *     video, and the configured list is observable on both peers (so we know it
 *     was actually applied to the peer connections, not silently dropped).
 *  2. EMPTY / ABSENT list — the LAN-only default. Identical real session, with
 *     getIceServers() asserted empty on both ends (behavior unchanged).
 *
 * A loopback (localhost) ICE negotiation gathers host candidates and connects
 * without ever needing the STUN/TURN servers to answer, so pointing at an
 * unreachable STUN URL is harmless here yet still exercises the exact code path
 * that constructs `new RTCPeerConnection({ iceServers })`. No third-party server
 * is contacted; the STUN URL below is a syntactically-valid, never-dialed dummy.
 */

// A harmless STUN-only list. On loopback the negotiation succeeds on host
// candidates before this server would ever be queried, so it is never actually
// contacted — it only proves the iceServers config flows into the peer.
const STUN_ONLY = 'stun:stun.invalid.test:3478';

/** Wait until the viewer's data channel (host-created `input`) reports open. */
async function waitForOpenDataChannel(viewer: Page): Promise<void> {
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).dataChannelOpen, {
      message: 'viewer data channel should open',
      timeout: 30_000,
    })
    .toBe(true);
}

/**
 * Bring up a real host+viewer session (optionally with an ICE list on the
 * query string of both pages) and assert that live, *moving* decoded video
 * arrives on the receive side and the data channel opens — i.e. the exact
 * success criteria of the canonical session spec.
 */
async function runRealSession(
  browser: Browser,
  code: string,
  ice: string | null,
): Promise<{ hostIce: RTCIceServer[]; viewerIce: RTCIceServer[] }> {
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

  const q = ice === null ? '' : `&ice=${encodeURIComponent(ice)}`;

  try {
    await host.goto(`/host-page.html?code=${code}${q}`);
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getState())).ready)
      .toBe(true);

    await viewer.goto(`/viewer-page.html?code=${code}${q}`);
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).ready)
      .toBe(true);

    // The connection reaches a live state on the viewer — proving ICE actually
    // negotiated a working candidate pair with the iceServers config applied.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).connectionState, {
        message: 'viewer connection state with iceServers configured',
        timeout: 30_000,
      })
      .toMatch(/connected|completed/);

    // Viewer receives a real video track and decodes live, advancing frames.
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).gotTrack)
      .toBe(true);

    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
        message: 'remote video width should be > 0',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    const decoded1 = await viewer.evaluate(() => window.__viewer.getDecodedFrameCount());
    await expect
      .poll(async () => viewer.evaluate(() => window.__viewer.getDecodedFrameCount()), {
        message: 'viewer should keep decoding new frames with iceServers configured',
        timeout: 30_000,
      })
      .toBeGreaterThan(decoded1);

    // Data channel is up — the viewer→host input path survives too.
    await waitForOpenDataChannel(viewer);

    // Read back the ICE list each peer actually configured its connections with.
    const hostIce = await host.evaluate(() => window.__host.getIceServers());
    const viewerIce = await viewer.evaluate(() => window.__viewer.getIceServers());
    return { hostIce, viewerIce };
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
}

test('STUN-only iceServers do not regress the real LAN/loopback session', async ({ browser }) => {
  const { hostIce, viewerIce } = await runRealSession(browser, '661001', STUN_ONLY);

  // Both peers were configured with the SAME single STUN server (as the
  // signaling server would distribute), and the connection still streamed.
  expect(hostIce).toEqual([{ urls: 'stun:stun.invalid.test:3478' }]);
  expect(viewerIce).toEqual([{ urls: 'stun:stun.invalid.test:3478' }]);
});

test('empty iceServers keep the exact LAN-only default behavior', async ({ browser }) => {
  const { hostIce, viewerIce } = await runRealSession(browser, '661002', null);

  // No ICE servers configured anywhere — unchanged LAN-only default, and the
  // real session connected and streamed identically.
  expect(hostIce).toEqual([]);
  expect(viewerIce).toEqual([]);
});
