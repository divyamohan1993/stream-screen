import { test, expect } from '@playwright/test';

/**
 * Control-channel features end to end over a real WebRTC `control` data channel:
 *   - multi-monitor: viewer requests the monitor list, host replies, viewer
 *     switches the active monitor and the host acks `monitor-switched` after an
 *     in-place replaceVideoTrack (no renegotiation);
 *   - chat: text round-trips in both directions (viewer→host and host→viewer).
 */

const code = '880033';

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

  await host.goto(`/host-page.html?code=${code}`);
  await viewer.goto(`/viewer-page.html?code=${code}`);

  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).dataChannelOpen, {
      timeout: 30_000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await host.evaluate(() => window.__host.getState())).connectionState, {
      timeout: 30_000,
    })
    .toMatch(/connected|completed/);
  // Viewer needs decoded video before a monitor switch is meaningful.
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  return { hostCtx, viewerCtx, host, viewer };
}

test('viewer can enumerate monitors and switch the active monitor at runtime', async ({
  browser,
}) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    // request-monitors -> host replies with the list.
    await viewer.evaluate(() => window.__viewer.requestMonitors());
    await expect
      .poll(async () => (await viewer.evaluate(() => window.__viewer.getMonitors())).length, {
        message: 'viewer should receive the monitor list',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(2);

    const monitors = await viewer.evaluate(() => window.__viewer.getMonitors());
    expect(monitors.some((m) => m.primary)).toBe(true);
    const target = monitors.find((m) => !m.primary)!;
    expect(target).toBeTruthy();

    // switch-monitor -> host swaps the outbound track and acks monitor-switched.
    await viewer.evaluate((id) => window.__viewer.switchMonitor(id), target.id);

    await expect
      .poll(async () => viewer.evaluate(() => window.__viewer.getMonitorSwitched()), {
        message: 'viewer should receive monitor-switched ack',
        timeout: 15_000,
      })
      .toBe(target.id);

    // Host side reflects the new active monitor.
    await expect
      .poll(async () => host.evaluate(() => window.__host.getActiveMonitor()))
      .toBe(target.id);

    // Video keeps flowing after the in-place track replacement (no renegotiation).
    const size = await viewer.evaluate(() => window.__viewer.getVideoSize());
    expect(size.width).toBeGreaterThan(0);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});

test('chat round-trips in both directions', async ({ browser }) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    // viewer -> host
    await viewer.evaluate(() => window.__viewer.sendChat('hello from viewer'));
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getChats())).map((c) => c.text), {
        message: 'host should receive viewer chat',
        timeout: 15_000,
      })
      .toContain('hello from viewer');

    // host -> viewer
    await host.evaluate(() => window.__host.sendChat('hello from host'));
    await expect
      .poll(
        async () =>
          (await viewer.evaluate(() => window.__viewer.getChats())).map((c) => c.text),
        { message: 'viewer should receive host chat', timeout: 15_000 },
      )
      .toContain('hello from host');

    // The chat messages carry a numeric timestamp (control-message contract).
    const hostChats = await host.evaluate(() => window.__host.getChats());
    expect(typeof hostChats[0].ts).toBe('number');
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
