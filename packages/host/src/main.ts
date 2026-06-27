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
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { InputEvent, MonitorInfo } from '@stream-screen/core';
import { InputInjector } from './input-injector.js';
import { generateSessionCode } from './host-session.js';
import {
  buildMonitorList,
  geometryForSource,
  type DisplayGeometry,
  type RawScreenSource,
} from './monitor.js';
import { resolveDownloadPath } from './file-save.js';
import type {
  HostBootConfig,
  PickedFile,
  RawSource,
  SaveFileRequest,
  SaveFileResult,
} from './preload.js';

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
      sandbox: true,
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

/** Snapshot the connected displays as plain {@link DisplayGeometry} objects. */
function collectDisplays(): DisplayGeometry[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor,
  }));
}

/** Enumerate just the screen sources (for multi-monitor listing/switching). */
async function collectScreenSources(): Promise<RawScreenSource[]> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false });
  return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));
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

  ipcMain.handle('ss:get-screen-sources', (): Promise<RawSource[]> => collectScreenSources());

  ipcMain.handle('ss:get-displays', (): DisplayGeometry[] => collectDisplays());

  ipcMain.handle('ss:get-monitors', async (): Promise<MonitorInfo[]> => {
    const [sources, displays] = await Promise.all([
      collectScreenSources(),
      Promise.resolve(collectDisplays()),
    ]);
    return buildMonitorList(sources, displays);
  });

  // When the host picks/switches a shared screen, plumb that display's geometry
  // (bounds + scaleFactor) into the injector so remote clicks land on the right
  // monitor in the right pixel space — the multi-monitor / HiDPI fix.
  ipcMain.on('ss:set-active-display', (_evt, sourceId: string) => {
    void (async () => {
      const sources = await collectScreenSources();
      const source = sources.find((s) => s.id === sourceId);
      const geom = source ? geometryForSource(source, collectDisplays()) : null;
      injector.setDisplayGeometry(geom);
    })();
  });

  ipcMain.on('ss:inject-input', (_evt, raw: InputEvent) => {
    if (raw && raw.t === 'clipboard') {
      // type_text / clipboard sync: write the text into Electron's clipboard,
      // then synthesize Ctrl+V so it actually lands in the focused field. Writing
      // the clipboard alone would type nothing — the historical no-op that made
      // the AI's most-used control tool silently ineffective.
      clipboard.writeText(raw.text);
      void injector.paste();
      return;
    }
    void injector.inject(raw);
  });

  ipcMain.on('ss:inject-combo', (_evt, events: InputEvent[]) => {
    if (Array.isArray(events)) void injector.injectCombo(events);
  });

  ipcMain.on('ss:status', (_evt, status: string) => {
    if (tray) tray.setToolTip(`StreamScreen Host — code ${bootConfig.code} — ${status}`);
  });

  // Save an inbound transferred file. Offers a save dialog; if cancelled, the
  // transfer is discarded (returns { path: null }). The default location is the
  // OS Downloads folder with a non-colliding, sanitized name.
  ipcMain.handle('ss:save-file', async (_evt, req: SaveFileRequest): Promise<SaveFileResult> => {
    const downloads = app.getPath('downloads');
    const defaultPath = resolveDownloadPath(downloads, req.name, existsSync);
    const result = await dialog.showSaveDialog({ defaultPath });
    if (result.canceled || !result.filePath) return { path: null };
    const bytes = req.data instanceof Uint8Array ? req.data : new Uint8Array(req.data);
    writeFileSync(result.filePath, bytes);
    return { path: result.filePath };
  });

  // Open a picker so the host can choose a file to push to the viewer.
  ipcMain.handle('ss:pick-file', async (): Promise<PickedFile | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const data = await readFile(filePath);
    return { name: basename(filePath), mime: 'application/octet-stream', data: new Uint8Array(data) };
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
