import { test, expect, type Page } from '@playwright/test';
import type { AdaptiveStats } from '@stream-screen/core';

/**
 * Proves the auto-negotiate-lag engine's CLOSED LOOP over a REAL WebRTC
 * connection, end to end:
 *
 *  1. A real host+viewer session is established through the live signaling server
 *     (two Chromium contexts, real peer-to-peer media + data channels), exactly
 *     like session.spec — so there is a genuine outbound RTCRtpSender carrying
 *     video to the viewer.
 *  2. On the HOST page we drive the REAL pipeline: feed the real
 *     AdaptiveController a stats sequence and call peer.applyDecision(decision)
 *     on the live connection, then read the encodings straight off the real
 *     RTCRtpSender (getParameters().encodings[0]).
 *  3. A CONGESTED sequence (high rtt/loss/jitter, and separately a high
 *     receiver-side playoutMs) DROPS the sender's maxBitrate/maxFramerate and
 *     RAISES scaleResolutionDownBy versus a healthy baseline; a CLEAN sequence
 *     then RECOVERS the bitrate. This proves auto-negotiation reaches the real
 *     RTCRtpSender — the loop is closed against actual WebRTC, not a mock.
 *  4. The VIEWER reports interactive-latency telemetry to the HOST over the real
 *     `control` channel via the { t:'latency' } ControlMessage, and the host
 *     receives the parsed values (the feedback edge of the loop).
 *
 * The background 1Hz adaptive tick on the host is suspended while we drive the
 * pipeline so it cannot overwrite the sender's encodings between applyDecision
 * and the assertion (we poll/read deterministically instead of sleeping).
 */

const code = '770099';

interface Peers {
  hostCtx: Awaited<ReturnType<Page['context']>>;
  viewerCtx: Awaited<ReturnType<Page['context']>>;
  host: Page;
  viewer: Page;
}

async function bringUp(
  browser: Parameters<Parameters<typeof test>[2]>[0]['browser'],
): Promise<Peers> {
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

  // Real connection up on both ends.
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).connectionState, {
      message: 'viewer connection state',
      timeout: 30_000,
    })
    .toMatch(/connected|completed/);
  await expect
    .poll(async () => (await host.evaluate(() => window.__host.getState())).connectionState, {
      message: 'host connection state',
      timeout: 30_000,
    })
    .toMatch(/connected|completed/);
  // Video is genuinely flowing — the sender exists and carries a real track.
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getVideoSize())).width, {
      message: 'remote video width should be > 0',
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  // Control channel open both ways (the latency feedback edge needs it).
  await expect
    .poll(async () => (await viewer.evaluate(() => window.__viewer.getState())).dataChannelOpen, {
      message: 'viewer data channel should open',
      timeout: 30_000,
    })
    .toBe(true);

  return { hostCtx, viewerCtx, host, viewer };
}

/** Build a stats sequence: `cleanN` healthy ticks, then `congestedN` congested ones. */
function buildSeq(opts: {
  cleanN: number;
  congested?: Partial<AdaptiveStats>;
  congestedN?: number;
}): AdaptiveStats[] {
  const clean = (): AdaptiveStats => ({
    rttMs: 20,
    lossPct: 0,
    jitterMs: 2,
    availableKbps: 50000,
    fps: 60,
    width: 1920,
    height: 1080,
    playoutMs: 5,
    ts: Date.now(),
  });
  const seq: AdaptiveStats[] = [];
  for (let i = 0; i < opts.cleanN; i++) seq.push(clean());
  for (let i = 0; i < (opts.congestedN ?? 0); i++) {
    seq.push({ ...clean(), ...opts.congested, ts: Date.now() });
  }
  return seq;
}

test('closed loop: congestion drops the REAL sender encodings, clean recovers them', async ({
  browser,
}) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);
  // The viewer is the live receive end that makes the sender real; the host-side
  // assertions don't reference it directly after bring-up.
  void viewer;

  try {
    // Suspend the background tick so our driven decisions are the only writes to
    // the sender between applyDecision and the read-back.
    await host.evaluate(() => window.__host.setAutoAdaptive(false));

    // Sanity: the live outbound video sender exists and is readable off the real
    // RTCRtpSender before we drive anything.
    await expect
      .poll(async () => host.evaluate(() => window.__host.getVideoSenderParams() !== null), {
        message: 'host should expose a live video sender',
        timeout: 15_000,
      })
      .toBe(true);

    // (A) Healthy baseline: ramp up on a clean link and read the real sender.
    const healthy = await host.evaluate(
      (seq) => window.__host.driveAdaptive(seq),
      buildSeq({ cleanN: 14 }),
    );
    expect(healthy.params).not.toBeNull();
    const baseBitrate = healthy.params!.maxBitrate!;
    const baseFramerate = healthy.params!.maxFramerate!;
    const baseScale = healthy.params!.scaleResolutionDownBy!;
    expect(baseBitrate).toBeGreaterThan(0);
    // degradationPreference is set by the real applyDecision on the real sender.
    expect(healthy.params!.degradationPreference).toBe('maintain-resolution');

    // (B) Network congestion: heavy loss + high RTT + jitter after the same ramp.
    // The real sender's maxBitrate must drop below the healthy baseline, and
    // framerate/scale must move the quality-shedding way.
    const congestedNet = await host.evaluate(
      (seq) => window.__host.driveAdaptive(seq),
      buildSeq({
        cleanN: 14,
        congestedN: 6,
        congested: { rttMs: 420, lossPct: 14, jitterMs: 80, availableKbps: 0 },
      }),
    );
    expect(congestedNet.params).not.toBeNull();
    expect(congestedNet.params!.maxBitrate!).toBeLessThan(baseBitrate);
    expect(congestedNet.params!.maxFramerate!).toBeLessThanOrEqual(baseFramerate);
    expect(congestedNet.params!.scaleResolutionDownBy!).toBeGreaterThanOrEqual(baseScale);

    // (C) Receiver-side queueing ALONE forces real-time backoff: network RTT is
    // healthy but playoutMs blows the end-to-end interactive budget. This proves
    // the engine prioritizes real-time latency, not just wire RTT.
    const congestedPlayout = await host.evaluate(
      (seq) => window.__host.driveAdaptive(seq),
      buildSeq({
        cleanN: 14,
        congestedN: 6,
        // rtt under target (120), but rtt+playout = 60+260 = 320 >> target*1.6.
        congested: { rttMs: 60, lossPct: 0, jitterMs: 2, playoutMs: 260, availableKbps: 0 },
      }),
    );
    expect(congestedPlayout.params).not.toBeNull();
    expect(congestedPlayout.params!.maxBitrate!).toBeLessThan(baseBitrate);

    // (D) Recovery: after driving the sender down hard, a sustained clean link
    // ramps the REAL sender's bitrate back up well above the congested trough.
    const recovery = await host.evaluate(
      (seq) => window.__host.driveAdaptive(seq),
      [
        // First crater the controller's internal state with severe congestion...
        ...buildSeq({
          cleanN: 0,
          congestedN: 10,
          congested: { rttMs: 2000, lossPct: 50, jitterMs: 500, availableKbps: 1 },
        }),
        // ...then sustain a pristine link so it climbs back up.
        ...buildSeq({ cleanN: 0, congestedN: 30, congested: { availableKbps: 50000 } }),
      ] as AdaptiveStats[],
    );
    expect(recovery.params).not.toBeNull();
    // The controller cratered to its floor during the severe-congestion phase,
    // then recovered: the final REAL sender bitrate is well above that trough.
    const troughKbps = Math.min(...recovery.decisions.map((d) => d.targetKbps));
    const recoveredKbps = recovery.params!.maxBitrate! / 1000;
    expect(recoveredKbps).toBeGreaterThan(troughKbps * 3);
    expect(recoveredKbps).toBeGreaterThan(1_500); // climbed back above 1.5 Mbps

    // The decisions inside the recovery call are themselves monotonic up over the
    // clean tail — auto-negotiation actively ramping the link back.
    const tail = recovery.decisions.slice(-12).map((d) => d.targetKbps);
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]).toBeGreaterThanOrEqual(tail[i - 1]);
    }
    expect(tail[tail.length - 1]).toBeGreaterThan(tail[0]);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});

test('latency feedback: viewer reports { t:latency } telemetry and the host receives it', async ({
  browser,
}) => {
  const { hostCtx, viewerCtx, host, viewer } = await bringUp(browser);

  try {
    // (1) Explicit, deterministic values: the viewer sends a latency frame and
    // the host receives the exact parsed rttMs/playoutMs/fps over the real
    // control channel (proves the new ControlMessage variant round-trips).
    const sent = await viewer.evaluate(() => window.__viewer.sendLatency(73, 21, 48));
    expect(sent).toMatchObject({ t: 'latency', rttMs: 73, playoutMs: 21, fps: 48 });

    await expect
      .poll(async () => host.evaluate(() => window.__host.getReceivedLatency()), {
        message: 'host should receive the viewer latency telemetry',
        timeout: 15_000,
      })
      .toContainEqual({ rttMs: 73, playoutMs: 21, fps: 48 });

    // (2) Live telemetry: the viewer derives real interactive-latency telemetry
    // from the WebRTC stats (getLocalTelemetry) and reports it; the host receives
    // a structurally-valid frame with finite numeric fields.
    await expect
      .poll(
        async () => {
          const tel = await viewer.evaluate(() => window.__viewer.getLocalTelemetry());
          return typeof (tel as { rttMs?: number }).rttMs === 'number';
        },
        { message: 'viewer should derive local telemetry', timeout: 15_000 },
      )
      .toBe(true);

    const before = await host.evaluate(() => window.__host.getReceivedLatency().length);
    await viewer.evaluate(() => window.__viewer.sendLatency());
    await expect
      .poll(async () => host.evaluate(() => window.__host.getReceivedLatency().length), {
        message: 'host should receive a second (live) latency frame',
        timeout: 15_000,
      })
      .toBeGreaterThan(before);

    const reports = await host.evaluate(() => window.__host.getReceivedLatency());
    const live = reports[reports.length - 1];
    expect(Number.isFinite(live.rttMs)).toBe(true);
    expect(Number.isFinite(live.playoutMs)).toBe(true);
    expect(live.rttMs).toBeGreaterThanOrEqual(0);
    expect(live.playoutMs).toBeGreaterThanOrEqual(0);
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
