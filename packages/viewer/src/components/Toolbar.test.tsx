import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toolbar, type ToolbarProps } from './Toolbar.js';

function baseProps(over: Partial<ToolbarProps> = {}): ToolbarProps {
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

describe('Toolbar mute toggle (feature A)', () => {
  it('shows muted state and fires onToggleMute on click', () => {
    const onToggleMute = vi.fn();
    render(<Toolbar {...baseProps({ muted: true, onToggleMute })} />);
    const btn = screen.getByLabelText('Unmute audio');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('reflects unmuted state', () => {
    render(<Toolbar {...baseProps({ muted: false })} />);
    const btn = screen.getByLabelText('Mute audio');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('volume slider reports changes', () => {
    const onVolume = vi.fn();
    render(<Toolbar {...baseProps({ onVolume })} />);
    const slider = screen.getByLabelText('Volume') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(onVolume).toHaveBeenCalledWith(0.5);
  });
});

describe('Toolbar special keys (feature F)', () => {
  it('fires Ctrl+Alt+Del and Win actions', () => {
    const onCtrlAltDel = vi.fn();
    const onWinKey = vi.fn();
    render(<Toolbar {...baseProps({ onCtrlAltDel, onWinKey })} />);
    fireEvent.click(screen.getByText('Ctrl+Alt+Del'));
    fireEvent.click(screen.getByText('Win'));
    expect(onCtrlAltDel).toHaveBeenCalledTimes(1);
    expect(onWinKey).toHaveBeenCalledTimes(1);
  });
});

describe('Toolbar recording (feature D)', () => {
  it('disables the record button when unsupported', () => {
    render(<Toolbar {...baseProps({ recordingSupported: false })} />);
    expect((screen.getByText('⏺ Record') as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows stop label while recording', () => {
    render(<Toolbar {...baseProps({ recording: true })} />);
    expect(screen.getByText('⏹ Stop rec')).toBeTruthy();
  });
});

describe('Toolbar monitor switcher (feature C)', () => {
  it('hides the switcher for a single monitor', () => {
    render(
      <Toolbar
        {...baseProps({ monitors: [{ id: 'm1', name: 'D1', primary: true, width: 1, height: 1 }] })}
      />,
    );
    expect(screen.queryByLabelText('Monitor')).toBeNull();
  });

  it('renders and switches between multiple monitors', () => {
    const onSwitchMonitor = vi.fn();
    render(
      <Toolbar
        {...baseProps({
          onSwitchMonitor,
          monitors: [
            { id: 'm1', name: 'D1', primary: true, width: 1920, height: 1080 },
            { id: 'm2', name: 'D2', primary: false, width: 1280, height: 720 },
          ],
        })}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'm2' } });
    expect(onSwitchMonitor).toHaveBeenCalledWith('m2');
  });
});
