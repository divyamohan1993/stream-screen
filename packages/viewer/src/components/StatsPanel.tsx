import React from 'react';
import type { AdaptiveStats, AdaptiveDecision } from '@stream-screen/core';

/** Props for {@link StatsPanel}. */
export interface StatsPanelProps {
  /** Latest live stats snapshot (from peer 'stats' events / polling). */
  stats: AdaptiveStats | null;
  /** Latest adaptive decision (mirrored client-side for the reason string). */
  decision: AdaptiveDecision | null;
}

/** Classify a metric value into a quality tier for color coding. */
function tier(value: number, warn: number, bad: number): 'good' | 'warn' | 'bad' {
  if (value >= bad) return 'bad';
  if (value >= warn) return 'warn';
  return 'good';
}

/**
 * Live connection-quality dashboard: RTT, end-to-end interactive Latency
 * (network RTT + receiver playout/jitter-buffer delay), packet loss, jitter,
 * available bitrate, framerate, and resolution, plus the current
 * {@link AdaptiveDecision} reason so the user can see exactly how the engine is
 * "auto-negotiating lag" in real time and that it is staying real-time.
 */
export function StatsPanel({ stats, decision }: StatsPanelProps): React.JSX.Element {
  return (
    <div className="stats-panel" role="status" aria-live="polite">
      <h4>Live stats</h4>
      {stats ? (
        <>
          <Row
            k="RTT"
            v={`${Math.round(stats.rttMs)} ms`}
            cls={tier(stats.rttMs, 120, 250)}
          />
          <Row
            k="Latency"
            v={`${Math.round(stats.rttMs + (stats.playoutMs ?? 0))} ms`}
            cls={tier(stats.rttMs + (stats.playoutMs ?? 0), 120, 250)}
          />
          <Row
            k="Loss"
            v={`${stats.lossPct.toFixed(1)} %`}
            cls={tier(stats.lossPct, 2, 5)}
          />
          <Row
            k="Jitter"
            v={`${Math.round(stats.jitterMs)} ms`}
            cls={tier(stats.jitterMs, 30, 60)}
          />
          <Row k="Bitrate" v={`${formatKbps(stats.availableKbps)}`} />
          <Row k="FPS" v={`${Math.round(stats.fps)}`} />
          <Row
            k="Resolution"
            v={stats.width && stats.height ? `${stats.width}×${stats.height}` : '—'}
          />
        </>
      ) : (
        <p className="hint">Waiting for first sample…</p>
      )}
      {decision ? <div className="decision-reason">{decision.reason}</div> : null}
    </div>
  );
}

function Row({ k, v, cls }: { k: string; v: string; cls?: 'good' | 'warn' | 'bad' }): React.JSX.Element {
  return (
    <div className="stat-row">
      <span className="k">{k}</span>
      <span className={`v${cls ? ` ${cls}` : ''}`}>{v}</span>
    </div>
  );
}

function formatKbps(kbps: number): string {
  if (kbps <= 0) return '—';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}
