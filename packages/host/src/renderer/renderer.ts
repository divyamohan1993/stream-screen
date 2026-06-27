/**
 * renderer — the host control window's renderer script.
 *
 * Pulls boot config and capturable sources over the preload bridge, lets the
 * user pick a screen, and runs a {@link HostSession} (capture + WebRTC + the
 * adaptive auto-negotiate-lag loop). Remote input events are forwarded back to
 * the main process for OS-level injection.
 */

import { HostSession } from '../host-session.js';
import { normalizeSources, pickDefaultSource, type CaptureSource } from '../capture.js';
import type { StreamScreenHostApi } from '../preload.js';
import type { FileMeta } from '@stream-screen/core';

declare global {
  interface Window {
    streamscreen: StreamScreenHostApi;
  }
}

const api = window.streamscreen;

const $code = document.getElementById('code') as HTMLDivElement;
const $source = document.getElementById('source') as HTMLSelectElement;
const $stats = document.getElementById('stats') as HTMLDivElement;

let session: HostSession | null = null;
let sources: CaptureSource[] = [];

async function boot(): Promise<void> {
  const cfg = await api.getBootConfig();
  $code.textContent = cfg.code;

  const raw = await api.getSources();
  sources = normalizeSources(raw);
  $source.innerHTML = '';
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    $source.appendChild(opt);
  }
  const def = pickDefaultSource(sources);
  if (def) $source.value = def.id;

  $source.addEventListener('change', () => {
    void startSession(cfg.signalingUrl, cfg.code, cfg.hostName, $source.value);
  });

  if (def) await startSession(cfg.signalingUrl, cfg.code, cfg.hostName, def.id);
}

async function startSession(
  signalingUrl: string,
  code: string,
  hostName: string,
  sourceId: string,
): Promise<void> {
  session?.stop();
  // Inform the main process which display is shared so remote clicks land on the
  // right monitor (multi-monitor / HiDPI coordinate mapping).
  api.setActiveDisplay(sourceId);
  session = new HostSession({
    signalingUrl,
    code,
    hostName,
    sourceId,
    getMonitors: () => api.getMonitors(),
    onActiveDisplay: (id) => api.setActiveDisplay(id),
    onFileReceived: (data, meta: FileMeta) => {
      void api.saveFile({ name: meta.name, mime: meta.mime, data });
    },
    onChat: (text) => {
      $stats.textContent = `Chat from viewer: ${text}`;
    },
    onInput: (e) => api.injectInput(e),
    onState: (state) => {
      api.reportStatus(state);
      $stats.textContent = `Connection: ${state}`;
    },
    onDecision: (d, s) => {
      $stats.textContent = [
        `Connection: live`,
        `RTT ${s.rttMs.toFixed(0)} ms · loss ${s.lossPct.toFixed(1)}% · jitter ${s.jitterMs.toFixed(0)} ms`,
        `${s.width}x${s.height} @ ${s.fps.toFixed(0)} fps`,
        `Target ${(d.targetKbps / 1000).toFixed(1)} Mbps · ${d.maxFramerate} fps · scale ÷${d.scaleResolutionDownBy}`,
        `Reason: ${d.reason}`,
      ].join('\n');
      api.reportStatus(`${(d.targetKbps / 1000).toFixed(1)}Mbps`);
    },
  });
  await session.start();
}

window.addEventListener('beforeunload', () => session?.stop());

void boot().catch((err) => {
  $stats.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
});
