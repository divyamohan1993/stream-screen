import React from 'react';
import type { AdaptiveStats, AdaptiveDecision } from '@stream-screen/core';

/** Props for {@link StatsPanel}. */
export interface StatsPanelProps {
  /** Latest live stats snapshot (from peer 'stats' events / polling). */
  stats: AdaptiveStats | null;
  /** Latest adaptive decision (mirrored client-side for the reason string). */
  decision: AdaptiveDecision | null;
  /**
   * Recent end-to-end interactive latency history (network rtt + receiver
   * playout), oldest first, used to draw the inline sparkline. Optional so the
   * panel still renders without a history (e.g. in isolation/tests).
   */
  latencyHistory?: number[];
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
 *
 * A small inline SVG sparkline visualizes the recent latency history with an
 * accessible text summary (current / average / max) as its label and fallback.
 */
export function StatsPanel({ stats, decision, latencyHistory = [] }: StatsPanelProps): React.JSX.Element {
  return (
    <div className="stats-panel" role="status" aria-live="polite" aria-label="Live connection stats">
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
          <Sparkline samples={latencyHistory} unit="ms" label="latency" />
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

/**
 * Inline SVG sparkline of the recent latency samples. Renders an accessible
 * text summary (current / avg / max) as its aria-label and as a visible caption,
 * so the trend is conveyed even when the SVG itself cannot be perceived.
 */
function Sparkline({
  samples,
  unit,
  label,
}: {
  samples: number[];
  unit: string;
  label: string;
}): React.JSX.Element {
  const W = 220;
  const H = 32;

  const valid = samples.filter((n) => Number.isFinite(n) && n >= 0);
  const current = valid.length > 0 ? valid[valid.length - 1] : 0;
  const max = valid.length > 0 ? Math.max(...valid) : 0;
  const min = valid.length > 0 ? Math.min(...valid) : 0;
  const avg = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;

  const summary =
    valid.length > 0
      ? `Recent ${label}: current ${Math.round(current)} ${unit}, average ${Math.round(
          avg,
        )} ${unit}, max ${Math.round(max)} ${unit}, over the last ${valid.length} samples.`
      : `No ${label} samples yet.`;

  // Build the polyline path. With a flat range, draw a centered horizontal line.
  const span = max - min || 1;
  const points =
    valid.length >= 2
      ? valid
          .map((v, i) => {
            const x = (i / (valid.length - 1)) * W;
            // Map value→y with 2px padding; higher latency draws higher up.
            const y = H - 2 - ((v - min) / span) * (H - 4);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ')
      : '';

  return (
    <div className="stat-sparkline" role="img" aria-label={summary}>
      {valid.length >= 2 ? (
        <svg
          className="sparkline-svg"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <polyline
            className="sparkline-line"
            fill="none"
            points={points}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
      <span className="sparkline-summary">{summary}</span>
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
