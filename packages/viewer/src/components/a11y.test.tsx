import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toolbar, type ToolbarProps } from './Toolbar.js';
import { ChatPanel } from './ChatPanel.js';
import { FileTransferPanel } from './FileTransferPanel.js';

function toolbarProps(over: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    state: 'connected',
    preset: 'Auto',
    onPreset: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onTogglePointerLock: vi.fn(),
    onToggleStats: vi.fn(),
    onDisconnect: vi.fn(),
    statsVisible: true,
    muted: true,
    volume: 1,
    onToggleMute: vi.fn(),
    onVolume: vi.fn(),
    recording: false,
    recordingSupported: true,
    onToggleRecording: vi.fn(),
    onCtrlAltDel: vi.fn(),
    onWinKey: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleFiles: vi.fn(),
    chatVisible: false,
    filesVisible: false,
    monitors: [],
    activeMonitorId: null,
    onSwitchMonitor: vi.fn(),
    onRefreshMonitors: vi.fn(),
    ...over,
  };
}

describe('Toolbar accessibility', () => {
  it('is a labeled toolbar landmark', () => {
    render(<Toolbar {...toolbarProps()} />);
    expect(screen.getByRole('toolbar', { name: /session controls/i })).toBeTruthy();
  });

  it('gives every control an accessible name', () => {
    render(<Toolbar {...toolbarProps()} />);
    // Every button must expose a non-empty accessible name.
    for (const btn of screen.getAllByRole('button')) {
      const name =
        btn.getAttribute('aria-label') ?? (btn.textContent ?? '').trim();
      expect(name.length).toBeGreaterThan(0);
    }
    // Icon-only / abbreviated controls resolve to descriptive names.
    expect(screen.getByRole('button', { name: /unmute audio/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /start recording/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /disconnect from host/i })).toBeTruthy();
  });

  it('exposes toggle state via aria-pressed on toggle buttons', () => {
    render(<Toolbar {...toolbarProps({ statsVisible: true, chatVisible: true })} />);
    expect(
      screen.getByRole('button', { name: /toggle stats panel/i }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /toggle chat panel/i }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('marks the active quality preset with aria-pressed', () => {
    render(<Toolbar {...toolbarProps({ preset: 'Auto' })} />);
    const auto = screen.getByRole('button', { name: /quality preset auto/i });
    expect(auto.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ChatPanel accessibility', () => {
  it('is a labeled region with a live message log and focuses its input', () => {
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('region', { name: /chat/i })).toBeTruthy();
    expect(screen.getByRole('log', { name: /chat messages/i })).toBeTruthy();
    // Focus is moved into the panel on open (logical tab order / keyboard use).
    expect(document.activeElement).toBe(screen.getByLabelText('Chat message'));
    expect(screen.getByRole('button', { name: /close chat/i })).toBeTruthy();
  });
});

describe('FileTransferPanel accessibility', () => {
  it('is a labeled region; the drop zone is keyboard operable', () => {
    const onSendFile = vi.fn();
    render(<FileTransferPanel transfers={[]} onSendFile={onSendFile} onClose={vi.fn()} />);
    expect(screen.getByRole('region', { name: /file transfer/i })).toBeTruthy();
    const drop = screen.getByRole('button', { name: /drop files here or click to choose/i });
    // The drop zone receives focus on open and is in the tab order.
    expect(document.activeElement).toBe(drop);
    expect(drop.getAttribute('tabindex')).toBe('0');
  });

  it('exposes a progressbar with value for each transfer', () => {
    render(
      <FileTransferPanel
        transfers={[
          {
            id: 't1',
            name: 'doc.pdf',
            size: 200,
            mime: 'application/pdf',
            progress: 100,
            status: 'active',
            direction: 'out',
          },
        ]}
        onSendFile={vi.fn()}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: /doc\.pdf progress/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });
});
