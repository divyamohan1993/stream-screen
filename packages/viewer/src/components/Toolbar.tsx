import React from 'react';
import type { MonitorInfo } from '@stream-screen/core';
import { QUALITY_PRESETS, type QualityPreset } from '../quality.js';
import type { SessionState } from '../viewer-session.js';
import { MonitorSwitcher } from './MonitorSwitcher.js';

/** Props for {@link Toolbar}. */
export interface ToolbarProps {
  state: SessionState;
  preset: QualityPreset;
  onPreset: (p: QualityPreset) => void;
  onToggleFullscreen: () => void;
  onTogglePointerLock: () => void;
  onToggleStats: () => void;
  onDisconnect: () => void;
  statsVisible: boolean;

  // Audio (feature A)
  muted: boolean;
  volume: number;
  onToggleMute: () => void;
  onVolume: (v: number) => void;

  // Recording (feature D)
  recording: boolean;
  recordingSupported: boolean;
  onToggleRecording: () => void;

  // Special keys (feature F)
  onCtrlAltDel: () => void;
  onWinKey: () => void;

  // Panels (chat / files)
  onToggleChat: () => void;
  onToggleFiles: () => void;
  chatVisible: boolean;
  filesVisible: boolean;

  // Multi-monitor (feature C)
  monitors: MonitorInfo[];
  activeMonitorId: string | null;
  onSwitchMonitor: (id: string) => void;
  onRefreshMonitors: () => void;
}

const STATE_LABEL: Record<SessionState, string> = {
  idle: 'idle',
  connecting: 'connecting',
  'waiting-for-host': 'waiting',
  reconnecting: 'reconnecting…',
  connected: 'connected',
  disconnected: 'disconnected',
  error: 'error',
};

/**
 * Top control bar: fullscreen, pointer-lock, quality presets, audio mute/volume,
 * session recording, special-key chords (Ctrl+Alt+Del / Win), chat + file
 * panels, the multi-monitor switcher, stats toggle, and disconnect — plus a live
 * connection-state pill and the always-free badge.
 */
export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const {
    state,
    preset,
    onPreset,
    onToggleFullscreen,
    onTogglePointerLock,
    onToggleStats,
    onDisconnect,
    statsVisible,
    muted,
    volume,
    onToggleMute,
    onVolume,
    recording,
    recordingSupported,
    onToggleRecording,
    onCtrlAltDel,
    onWinKey,
    onToggleChat,
    onToggleFiles,
    chatVisible,
    filesVisible,
    monitors,
    activeMonitorId,
    onSwitchMonitor,
    onRefreshMonitors,
  } = props;

  const pillClass =
    state === 'connected'
      ? 'state-pill connected'
      : state === 'error'
        ? 'state-pill error'
        : state === 'reconnecting'
          ? 'state-pill reconnecting'
          : 'state-pill';

  return (
    <div className="toolbar">
      <span className="brand">StreamScreen</span>
      <span className={pillClass}>{STATE_LABEL[state]}</span>
      <span className="free-badge">unlimited · free</span>

      <span className="spacer" />

      <div className="preset-group" role="group" aria-label="Quality preset">
        {QUALITY_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={p === preset ? 'active' : ''}
            onClick={() => onPreset(p)}
          >
            {p}
          </button>
        ))}
      </div>

      <MonitorSwitcher
        monitors={monitors}
        activeId={activeMonitorId}
        onSwitch={onSwitchMonitor}
        onRefresh={onRefreshMonitors}
      />

      <div className="audio-group" role="group" aria-label="Audio">
        <button
          type="button"
          onClick={onToggleMute}
          title={muted ? 'Unmute audio' : 'Mute audio'}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute audio' : 'Mute audio'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
          aria-label="Volume"
          title="Volume"
        />
      </div>

      <button
        type="button"
        className={recording ? 'active danger' : ''}
        onClick={onToggleRecording}
        disabled={!recordingSupported}
        title={recordingSupported ? 'Start/stop recording' : 'Recording unsupported'}
        aria-pressed={recording}
      >
        {recording ? '⏹ Stop rec' : '⏺ Record'}
      </button>

      <button type="button" onClick={onCtrlAltDel} title="Send Ctrl+Alt+Del">
        Ctrl+Alt+Del
      </button>
      <button type="button" onClick={onWinKey} title="Send Windows key">
        Win
      </button>

      <button
        type="button"
        className={chatVisible ? 'active' : ''}
        onClick={onToggleChat}
        aria-pressed={chatVisible}
        title="Toggle chat"
      >
        Chat
      </button>
      <button
        type="button"
        className={filesVisible ? 'active' : ''}
        onClick={onToggleFiles}
        aria-pressed={filesVisible}
        title="Toggle file transfer"
      >
        Files
      </button>

      <button type="button" onClick={onTogglePointerLock} title="Toggle pointer lock">
        Pointer lock
      </button>
      <button type="button" onClick={onToggleFullscreen} title="Toggle fullscreen">
        Fullscreen
      </button>
      <button type="button" onClick={onToggleStats} title="Toggle stats panel">
        {statsVisible ? 'Hide stats' : 'Show stats'}
      </button>
      <button type="button" className="danger" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}
