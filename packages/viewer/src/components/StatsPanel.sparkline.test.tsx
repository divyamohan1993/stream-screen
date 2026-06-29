import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AdaptiveStats } from '@stream-screen/core';
import { StatsPanel } from './StatsPanel.js';

function stats(over: Partial<AdaptiveStats> = {}): AdaptiveStats {
  return {
    rttMs: 40,
    lossPct: 0,
    jitterMs: 5,
    availableKbps: 5000,
    fps: 30,
    width: 1920,
    height: 1080,
    playoutMs: 0,
    ts: Date.now(),
    ...over,
  };
}

describe('StatsPanel latency sparkline', () => {
  it('renders the latency value alongside the sparkline', () => {
    render(
      <StatsPanel
        stats={stats({ rttMs: 40, playoutMs: 25 })}
        decision={null}
        latencyHistory={[50, 60, 65]}
      />,
    );
    const row = screen.getByText('Latency').closest('.stat-row')!;
    expect(row.querySelector('.v')!.textContent).toBe('65 ms');
    // The sparkline draws an SVG polyline once there are >= 2 samples.
    expect(document.querySelector('.sparkline-svg polyline')).toBeTruthy();
  });

  it('exposes an accessible summary of current/avg/max over N samples', () => {
    render(
      <StatsPanel
        stats={stats({ rttMs: 100, playoutMs: 20 })}
        decision={null}
        latencyHistory={[100, 200, 120]}
      />,
    );
    // current 120, avg 140, max 200, 3 samples.
    const sparkline = screen.getByRole('img', { name: /recent latency/i });
    const label = sparkline.getAttribute('aria-label')!;
    expect(label).toContain('current 120 ms');
    expect(label).toContain('average 140 ms');
    expect(label).toContain('max 200 ms');
    expect(label).toContain('3 samples');
  });

  it('renders a visible text fallback even without enough samples to draw a line', () => {
    render(<StatsPanel stats={stats()} decision={null} latencyHistory={[]} />);
    // No SVG yet (need >= 2 points) but the summary text must still be present.
    expect(document.querySelector('.sparkline-svg')).toBeNull();
    expect(screen.getByText(/no latency samples yet/i)).toBeTruthy();
  });

  it('still renders without a latencyHistory prop (backward compatible)', () => {
    render(<StatsPanel stats={stats()} decision={null} />);
    expect(screen.getByText('Latency')).toBeTruthy();
    expect(screen.getByRole('img', { name: /latency/i })).toBeTruthy();
  });
});
