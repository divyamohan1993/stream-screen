import { test, expect, type Page } from '@playwright/test';

/**
 * File transfer end to end. The viewer generates a multi-chunk byte array (50KB,
 * which is > 3 of the 16KiB chunks) and streams it to the host using the core
 * FileTransferManager wiring: a `file-offer` over the control channel, the
 * host's auto `file-accept`, the binary chunks over the reliable `file` channel,
 * and a final `file-complete`. The host reassembles the bytes and exposes the
 * received length and a content checksum, which we assert match the source
 * exactly — proving the chunk framing + reassembly round-trips real bytes over
 * a real WebRTC data channel.
 */

const code = '880022';

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

  // Both data channels (control + file) must be open before we transfer.
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

/** Generate `n` pseudo-random-ish bytes deterministically, plus their checksum. */
function makeBytes(n: number): { bytes: number[]; checksum: number } {
  const bytes = new Array<number>(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const b = (i * 31 + 7) & 0xff;
    bytes[i] = b;
    sum = (sum + b) >>> 0;
  }
  return { bytes, checksum: sum };
}

async function receivedFile(host: Page, id: string) {
  const files = await host.evaluate(() => window.__host.getReceivedFiles());
  return files.find((f) => f.id === id) ?? null;
}

test('viewer sends a multi-chunk file to the host with exact bytes/length/checksum', async ({
  browser,
}) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    const SIZE = 50 * 1024; // 50KB → spans 4 of the 16KiB chunks.
    const { bytes, checksum } = makeBytes(SIZE);
    const id = 'xfer-1';

    // Kick off the transfer. The viewer awaits accept (auto-sent by the host)
    // and resolves once every chunk + file-complete has been handed off.
    await viewer.evaluate(
      ({ id, bytes }) =>
        window.__viewer.sendFile(id, 'payload.bin', 'application/octet-stream', bytes),
      { id, bytes },
    );

    // The host should reassemble and record the completed file.
    await expect
      .poll(async () => (await receivedFile(host, id)) !== null, {
        message: 'host should complete and record the received file',
        timeout: 30_000,
      })
      .toBe(true);

    const file = await receivedFile(host, id);
    expect(file).not.toBeNull();
    expect(file!.length).toBe(SIZE);
    expect(file!.size).toBe(SIZE);
    expect(file!.checksum).toBe(checksum);
    expect(file!.name).toBe('payload.bin');
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
