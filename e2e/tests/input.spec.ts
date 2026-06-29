import { test, expect, type Page } from '@playwright/test';
import type { InputEvent } from '@stream-screen/core';

/**
 * Input pipeline end to end. Once the WebRTC session is up, the viewer sends
 * synthetic InputEvents (mouse move, click down/up, and a typed string) over
 * the data channel. We then assert the host page actually decoded and recorded
 * each event — proving the encode → data-channel → decode path works for real.
 */

const code = '777111';

async function bringUpSession(browser: Parameters<Parameters<typeof test>[2]>[0]['browser']) {
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await host.goto(`/host-page.html?code=${code}`);
  await viewer.goto(`/viewer-page.html?code=${code}`);

  // Wait until the viewer's input data channel is open (host-created channel,
  // received via ondatachannel) and the host connection is live.
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

  return { hostCtx, viewerCtx, host, viewer };
}

async function sendInput(viewer: Page, ev: InputEvent): Promise<void> {
  await viewer.evaluate((e) => window.__viewer.sendInput(e), ev);
}

test('viewer input events arrive on the host over the data channel', async ({ browser }) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUpSession(browser);

  try {
    const events: InputEvent[] = [
      { t: 'm-move', x: 0.25, y: 0.5 },
      { t: 'm-down', x: 0.25, y: 0.5, button: 0 },
      { t: 'm-up', x: 0.25, y: 0.5, button: 0 },
      ...'hello'.split('').flatMap<InputEvent>((ch) => [
        { t: 'k-down', code: `Key${ch.toUpperCase()}`, key: ch, mods: 0 },
        { t: 'k-up', code: `Key${ch.toUpperCase()}`, key: ch, mods: 0 },
      ]),
    ];

    for (const ev of events) {
      await sendInput(viewer, ev);
    }

    // All events should be recorded on the host, in order.
    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getReceivedInputs())).length, {
        message: 'host should receive every input event',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(events.length);

    const received = await host.evaluate(() => window.__host.getReceivedInputs());

    // The move/click trio arrived with correct coordinates and button.
    const move = received.find((e) => e.t === 'm-move');
    expect(move).toMatchObject({ t: 'm-move', x: 0.25, y: 0.5 });
    const down = received.find((e) => e.t === 'm-down');
    expect(down).toMatchObject({ t: 'm-down', button: 0 });

    // The typed string is reconstructable from the keydown events.
    const typed = received
      .filter((e): e is Extract<InputEvent, { t: 'k-down' }> => e.t === 'k-down')
      .map((e) => e.key)
      .join('');
    expect(typed).toContain('hello');
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
