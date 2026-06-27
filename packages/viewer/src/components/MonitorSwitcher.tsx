import React from 'react';
import type { MonitorInfo } from '@stream-screen/core';

/** Props for {@link MonitorSwitcher}. */
export interface MonitorSwitcherProps {
  /** Monitors the host advertised (empty until `monitors` arrives). */
  monitors: MonitorInfo[];
  /** The currently active monitor id (from `monitor-switched`), if known. */
  activeId: string | null;
  /** Request a runtime switch to another monitor. */
  onSwitch: (id: string) => void;
  /** Re-request the monitor list from the host. */
  onRefresh?: () => void;
}

/**
 * Multi-monitor picker. Renders the host's advertised {@link MonitorInfo} list
 * and lets the viewer switch the active capture target at runtime (the host
 * swaps the outbound video track via `replaceTrack`, no full renegotiation).
 */
export function MonitorSwitcher({
  monitors,
  activeId,
  onSwitch,
  onRefresh,
}: MonitorSwitcherProps): React.JSX.Element | null {
  // Hide the control entirely on single-monitor hosts to avoid clutter.
  if (monitors.length <= 1) return null;

  return (
    <div className="monitor-switcher" role="group" aria-label="Monitor">
      <label htmlFor="monitor-select" className="monitor-label">
        Monitor
      </label>
      <select
        id="monitor-select"
        value={activeId ?? monitors.find((m) => m.primary)?.id ?? monitors[0]?.id ?? ''}
        onChange={(e) => onSwitch(e.target.value)}
      >
        {monitors.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.primary ? ' (primary)' : ''} — {m.width}×{m.height}
          </option>
        ))}
      </select>
      {onRefresh && (
        <button type="button" onClick={onRefresh} title="Refresh monitors" aria-label="Refresh monitors">
          ⟳
        </button>
      )}
    </div>
  );
}
