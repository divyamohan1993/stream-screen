/**
 * preload — the contextBridge between the host's main and renderer processes.
 *
 * Runs in an isolated context with Node access and exposes a narrow, typed
 * `window.streamscreen` surface to the (sandboxed) renderer. The renderer never
 * touches Node/Electron directly; it goes through these channels.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { InputEvent, MonitorInfo } from '@stream-screen/core';
import type { DisplayGeometry } from './monitor.js';

/** A capturable desktop source as surfaced from the main process. */
export interface RawSource {
  id: string;
  name: string;
  display_id?: string;
}

/** A file to be saved on the host (inbound transfer), passed main → renderer-less. */
export interface SaveFileRequest {
  name: string;
  mime: string;
  /** The fully reassembled file bytes. */
  data: Uint8Array;
}

/** Result of a host-side save: the chosen path, or null if the user cancelled. */
export interface SaveFileResult {
  path: string | null;
}

/** A file the host chose to send to the viewer (outbound transfer). */
export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** Boot configuration handed from main → renderer when the session starts. */
export interface HostBootConfig {
  signalingUrl: string;
  code: string;
  hostName: string;
}

/** The API exposed on `window.streamscreen` in the renderer. */
export interface StreamScreenHostApi {
  /** Enumerate capturable screens/windows (proxied to desktopCapturer). */
  getSources(): Promise<RawSource[]>;
  /** Enumerate ONLY screen sources, for the multi-monitor list. */
  getScreenSources(): Promise<RawSource[]>;
  /** Enumerate physical displays with bounds + scaleFactor (Electron screen). */
  getDisplays(): Promise<DisplayGeometry[]>;
  /** Build the viewer-facing monitor list (sources joined to display geometry). */
  getMonitors(): Promise<MonitorInfo[]>;
  /** Fetch boot config (signaling url, session code, host name). */
  getBootConfig(): Promise<HostBootConfig>;
  /** Forward a received remote input event to the main process for injection. */
  injectInput(e: InputEvent): void;
  /** Forward a special-key chord (ordered event list) for atomic injection. */
  injectCombo(events: InputEvent[]): void;
  /** Tell the main process which display is now being shared (for coord mapping). */
  setActiveDisplay(sourceId: string): void;
  /** Report a status string (state / decision) up to the control window. */
  reportStatus(status: string): void;
  /** Save an inbound transferred file to disk; returns the chosen path or null. */
  saveFile(req: SaveFileRequest): Promise<SaveFileResult>;
  /** Open a picker so the host can choose a file to send to the viewer. */
  pickFile(): Promise<PickedFile | null>;
}

const api: StreamScreenHostApi = {
  getSources: () => ipcRenderer.invoke('ss:get-sources') as Promise<RawSource[]>,
  getScreenSources: () => ipcRenderer.invoke('ss:get-screen-sources') as Promise<RawSource[]>,
  getDisplays: () => ipcRenderer.invoke('ss:get-displays') as Promise<DisplayGeometry[]>,
  getMonitors: () => ipcRenderer.invoke('ss:get-monitors') as Promise<MonitorInfo[]>,
  getBootConfig: () => ipcRenderer.invoke('ss:get-boot-config') as Promise<HostBootConfig>,
  injectInput: (e: InputEvent) => ipcRenderer.send('ss:inject-input', e),
  injectCombo: (events: InputEvent[]) => ipcRenderer.send('ss:inject-combo', events),
  setActiveDisplay: (sourceId: string) => ipcRenderer.send('ss:set-active-display', sourceId),
  reportStatus: (status: string) => ipcRenderer.send('ss:status', status),
  saveFile: (req: SaveFileRequest) =>
    ipcRenderer.invoke('ss:save-file', req) as Promise<SaveFileResult>,
  pickFile: () => ipcRenderer.invoke('ss:pick-file') as Promise<PickedFile | null>,
};

contextBridge.exposeInMainWorld('streamscreen', api);
