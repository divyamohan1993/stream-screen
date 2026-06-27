import React from 'react';
import { QUALITY_PRESETS, type QualityPreset } from '../quality.js';
import type { SessionState } from '../viewer-session.js';

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
}

const STATE_LABEL: Record<SessionState, string> = {
  idle: 'idle',
  connecting: 'connecting',
  'waiting-for-host': 'waiting',
  connected: 'connected',
  disconnected: 'disconnected',
  error: 'error',
};

/**
 * Top control bar: fullscreen, pointer-lock, quality presets
 * (Auto/High/Balanced/Low), stats toggle, and disconnect — plus a live
 * connection-state pill and the always-free badge.
 */
export function Toolbar({
  state,
  preset,
  onPreset,
  onToggleFullscreen,
  onTogglePointerLock,
  onToggleStats,
  onDisconnect,
  statsVisible,
}: ToolbarProps): React.JSX.Element {
  const pillClass =
    state === 'connected' ? 'state-pill connected' : state === 'error' ? 'state-pill error' : 'state-pill';

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
