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

describe('StatsPanel real-time latency', () => {
  it('renders the end-to-end interactive latency (rtt + playout)', () => {
    render(<StatsPanel stats={stats({ rttMs: 40, playoutMs: 25 })} decision={null} />);
    const row = screen.getByText('Latency').closest('.stat-row')!;
    // 40 + 25 = 65 ms end-to-end interactive latency.
    expect(row.querySelector('.v')!.textContent).toBe('65 ms');
  });

  it('treats absent playoutMs as 0 (latency equals rtt)', () => {
    const s = stats({ rttMs: 80 });
    delete (s as { playoutMs?: number }).playoutMs;
    render(<StatsPanel stats={s} decision={null} />);
    const row = screen.getByText('Latency').closest('.stat-row')!;
    expect(row.querySelector('.v')!.textContent).toBe('80 ms');
  });

  it('color-codes latency by the same tiers as RTT', () => {
    render(<StatsPanel stats={stats({ rttMs: 200, playoutMs: 100 })} decision={null} />);
    const row = screen.getByText('Latency').closest('.stat-row')!;
    // 300 ms is past the bad threshold (250).
    expect(row.querySelector('.v')!.className).toContain('bad');
  });

  it('shows a separate RTT row alongside the combined latency row', () => {
    render(<StatsPanel stats={stats({ rttMs: 40, playoutMs: 25 })} decision={null} />);
    const rtt = screen.getByText('RTT').closest('.stat-row')!;
    expect(rtt.querySelector('.v')!.textContent).toBe('40 ms');
  });
});
