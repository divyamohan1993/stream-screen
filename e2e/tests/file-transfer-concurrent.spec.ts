import { test, expect, type Page } from '@playwright/test';

/**
 * Concurrent file transfer end to end (viewer -> host), TWO files INTERLEAVED.
 *
 * The viewer starts two distinct multi-chunk transfers (40KB and 64KB, each
 * spanning several of the 16KiB chunks) and interleaves their binary chunks
 * round-robin over the SAME real `file` data channel. Every chunk carries its
 * own transfer id, so the host demultiplexes them with a ReceiverRouter into two
 * independent receivers.
 *
 * We assert BOTH files reassemble to their own exact length AND content checksum.
 * Because the two byte generators differ, a single byte of cross-contamination
 * (a chunk routed to the wrong receiver) would change a length and/or checksum —
 * so green here proves the transfer-id routing keeps the interleaved streams
 * completely separate over a real WebRTC connection.
 */

const code = '880099';

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

/**
 * Generate `n` deterministic bytes (with a per-transfer `salt` so the two files
 * are different byte streams) plus their mod-2^32 checksum.
 */
function makeBytes(n: number, salt: number): { bytes: number[]; checksum: number } {
  const bytes = new Array<number>(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const b = (i * (salt * 2 + 1) + salt * 13 + 7) & 0xff;
    bytes[i] = b;
    sum = (sum + b) >>> 0;
  }
  return { bytes, checksum: sum };
}

async function receivedFile(host: Page, id: string) {
  const files = await host.evaluate(() => window.__host.getReceivedFiles());
  return files.find((f) => f.id === id) ?? null;
}

test('viewer sends two interleaved multi-chunk files; host demuxes both with no cross-contamination', async ({
  browser,
}) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    const SIZE_A = 40 * 1024; // 40KB -> 3 of the 16KiB chunks.
    const SIZE_B = 64 * 1024; // 64KB -> exactly 4 of the 16KiB chunks.
    const idA = 'xfer-concurrent-A';
    const idB = 'xfer-concurrent-B';
    const a = makeBytes(SIZE_A, 1);
    const b = makeBytes(SIZE_B, 2);

    // Both transfers are started concurrently and their chunks interleaved over
    // the single binary `file` channel by the fixture.
    await viewer.evaluate(
      ({ idA, idB, aBytes, bBytes }) =>
        window.__viewer.sendFilesInterleaved([
          { id: idA, name: 'a.bin', mime: 'application/octet-stream', bytes: aBytes },
          { id: idB, name: 'b.bin', mime: 'application/octet-stream', bytes: bBytes },
        ]),
      { idA, idB, aBytes: a.bytes, bBytes: b.bytes },
    );

    // The host should reassemble and record BOTH completed files.
    await expect
      .poll(
        async () =>
          (await receivedFile(host, idA)) !== null && (await receivedFile(host, idB)) !== null,
        {
          message: 'host should complete and record both received files',
          timeout: 30_000,
        },
      )
      .toBe(true);

    const fileA = await receivedFile(host, idA);
    expect(fileA).not.toBeNull();
    expect(fileA!.length).toBe(SIZE_A);
    expect(fileA!.size).toBe(SIZE_A);
    expect(fileA!.checksum).toBe(a.checksum);
    expect(fileA!.name).toBe('a.bin');

    const fileB = await receivedFile(host, idB);
    expect(fileB).not.toBeNull();
    expect(fileB!.length).toBe(SIZE_B);
    expect(fileB!.size).toBe(SIZE_B);
    expect(fileB!.checksum).toBe(b.checksum);
    expect(fileB!.name).toBe('b.bin');

    // Cross-contamination guard: the two checksums must differ (the generators
    // differ), so equal checksums would betray bytes leaking between transfers.
    expect(a.checksum).not.toBe(b.checksum);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
