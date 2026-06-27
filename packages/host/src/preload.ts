/**
 * preload — the contextBridge between the host's main and renderer processes.
 *
 * Runs in an isolated context with Node access and exposes a narrow, typed
 * `window.streamscreen` surface to the (sandboxed) renderer. The renderer never
 * touches Node/Electron directly; it goes through these channels.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { InputEvent } from '@stream-screen/core';

/** A capturable desktop source as surfaced from the main process. */
export interface RawSource {
  id: string;
  name: string;
  display_id?: string;
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
  /** Fetch boot config (signaling url, session code, host name). */
  getBootConfig(): Promise<HostBootConfig>;
  /** Forward a received remote input event to the main process for injection. */
  injectInput(e: InputEvent): void;
  /** Report a status string (state / decision) up to the control window. */
  reportStatus(status: string): void;
}

const api: StreamScreenHostApi = {
  getSources: () => ipcRenderer.invoke('ss:get-sources') as Promise<RawSource[]>,
  getBootConfig: () => ipcRenderer.invoke('ss:get-boot-config') as Promise<HostBootConfig>,
  injectInput: (e: InputEvent) => ipcRenderer.send('ss:inject-input', e),
  reportStatus: (status: string) => ipcRenderer.send('ss:status', status),
};

contextBridge.exposeInMainWorld('streamscreen', api);
