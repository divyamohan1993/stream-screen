/**
 * main — the Electron main process for the StreamScreen HOST agent.
 *
 * Responsibilities:
 *   - Single-instance lock + lifecycle / quit handling.
 *   - System tray with the live session code and a quit action.
 *   - A small control window (the renderer) that runs the capture + WebRTC +
 *     adaptive loop via {@link HostSession}.
 *   - desktopCapturer source enumeration (main-process-only API), proxied to
 *     the renderer over IPC.
 *   - OS-level input injection of events the renderer forwards, via the
 *     optional {@link InputInjector}.
 *   - Clipboard sync (Electron clipboard) for `clipboard` input events.
 *
 * ALWAYS FREE / UNLIMITED: there is no licensing, no usage metering, and no
 * timer anywhere in this process that could end or throttle a session.
 */

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import type { InputEvent } from '@stream-screen/core';
import { InputInjector } from './input-injector.js';
import { generateSessionCode } from './host-session.js';
import type { HostBootConfig, RawSource } from './preload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the signaling URL from env, defaulting to a LAN-local server. */
function resolveSignalingUrl(): string {
  return process.env.STREAMSCREEN_SIGNALING_URL ?? 'ws://127.0.0.1:8787';
}

/** The boot config for this run — the session code is fixed for the app's life. */
const bootConfig: HostBootConfig = {
  signalingUrl: resolveSignalingUrl(),
  code: process.env.STREAMSCREEN_CODE ?? generateSessionCode(6),
  hostName: process.env.STREAMSCREEN_HOST_NAME ?? hostname(),
};

const injector = new InputInjector();

let controlWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function createControlWindow(): void {
  controlWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    title: 'StreamScreen Host',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void controlWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  controlWindow.on('closed', () => {
    controlWindow = null;
  });
}

/** A tiny 1x1 transparent tray icon so we never depend on a bundled asset. */
function trayIcon() {
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  );
}

function createTray(): void {
  tray = new Tray(trayIcon());
  rebuildTrayMenu();
  tray.setToolTip(`StreamScreen Host — code ${bootConfig.code}`);
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `Session code: ${bootConfig.code}`, enabled: false },
    { label: `Host: ${bootConfig.hostName}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Show control window',
      click: () => {
        if (controlWindow) controlWindow.show();
        else createControlWindow();
      },
    },
    { type: 'separator' },
    { label: 'Quit StreamScreen Host', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
}

/** Register the IPC handlers the renderer relies on. */
function registerIpc(): void {
  ipcMain.handle('ss:get-boot-config', (): HostBootConfig => bootConfig);

  ipcMain.handle('ss:get-sources', async (): Promise<RawSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));
  });

  ipcMain.on('ss:inject-input', (_evt, raw: InputEvent) => {
    if (raw && raw.t === 'clipboard') {
      // Clipboard sync uses Electron's clipboard rather than synthetic keys.
      clipboard.writeText(raw.text);
      return;
    }
    void injector.inject(raw);
  });

  ipcMain.on('ss:status', (_evt, status: string) => {
    if (tray) tray.setToolTip(`StreamScreen Host — code ${bootConfig.code} — ${status}`);
  });
}

/** Acquire the single-instance lock; quit immediately if another copy holds it. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.show();
      controlWindow.focus();
    } else {
      createControlWindow();
    }
  });

  app.whenReady().then(async () => {
    await injector.init();
    registerIpc();
    createTray();
    createControlWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
    });
  });

  // Keep running in the tray when all windows are closed (no time limit, ever).
  app.on('window-all-closed', () => {
    // Intentionally do NOT quit on non-darwin: the host stays available in the
    // tray. The user quits explicitly from the tray menu.
  });
}

export { bootConfig };
