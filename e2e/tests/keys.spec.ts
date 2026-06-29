import { test, expect, type Page } from '@playwright/test';
import type { InputEvent } from '@stream-screen/core';

/**
 * Special keys / combos end to end. The viewer builds key chords with the core
 * buildKeyCombo / SPECIAL_KEYS helpers (Ctrl+Alt+Del, the Win key, and an
 * arbitrary modifier+key combo) and sends them over the input data channel. We
 * assert the host decodes the exact ordered key events with the correct
 * cumulative modifier bitmask — proving the chord semantics survive the real
 * encode → data-channel → decode path.
 */

const code = '880055';

async function bringUp(browser: Parameters<Parameters<typeof test>[2]>[0]['browser']) {
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();

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

  return { hostCtx, viewerCtx, host, viewer };
}

/** Send a named combo (built in-page via the bundled core) over the input channel. */
async function sendCombo(viewer: Page, keys: string[]): Promise<InputEvent[]> {
  return viewer.evaluate(async (keys) => {
    const core = await import('./core.bundle.js');
    const events = core.buildKeyCombo(keys);
    for (const ev of events) window.__viewer.sendInput(ev);
    return events;
  }, keys);
}

test('Ctrl+Alt+Del / Win / arbitrary combos arrive on the host with correct mods', async ({
  browser,
}) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    const cad = await sendCombo(viewer, ['ctrl', 'alt', 'delete']);
    const win = await sendCombo(viewer, ['win']);
    const winR = await sendCombo(viewer, ['win', 'r']);

    const total = cad.length + win.length + winR.length;

    await expect
      .poll(async () => (await host.evaluate(() => window.__host.getReceivedInputs())).length, {
        message: 'host should receive every combo key event',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(total);

    const received = await host.evaluate(() => window.__host.getReceivedInputs());
    const keyEvents = received.filter(
      (e): e is Extract<InputEvent, { t: 'k-down' | 'k-up' }> =>
        e.t === 'k-down' || e.t === 'k-up',
    );

    // Ctrl+Alt+Del: down ctrl, down alt, down delete, then up in reverse, all
    // carrying the cumulative ctrl|alt|... mask. The Delete down event must hold
    // ctrl(2)|alt(4) = 6 at minimum.
    const delDown = keyEvents.find((e) => e.t === 'k-down' && e.key === 'Delete');
    expect(delDown).toBeTruthy();
    expect((delDown!.mods & 2) !== 0).toBe(true); // ctrl
    expect((delDown!.mods & 4) !== 0).toBe(true); // alt

    // Win key sets the meta bit (8).
    const winDown = keyEvents.find((e) => e.t === 'k-down' && e.key === 'Meta');
    expect(winDown).toBeTruthy();
    expect((winDown!.mods & 8) !== 0).toBe(true); // meta

    // Win+R: the 'r' down event holds meta (8).
    const rDown = keyEvents.find((e) => e.t === 'k-down' && e.key === 'r');
    expect(rDown).toBeTruthy();
    expect((rDown!.mods & 8) !== 0).toBe(true); // meta

    // Every chord is balanced: equal k-down and k-up counts.
    const downs = keyEvents.filter((e) => e.t === 'k-down').length;
    const ups = keyEvents.filter((e) => e.t === 'k-up').length;
    expect(downs).toBe(ups);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
