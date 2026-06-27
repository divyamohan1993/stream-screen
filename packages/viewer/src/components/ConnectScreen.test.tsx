import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DiscoveredHost } from '../discovery-client.js';

// Drive the discovery path with controlled hosts so we can exercise pick().
const discoverHosts = vi.fn<() => Promise<DiscoveredHost[]>>();
vi.mock('../discovery-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery-client.js')>();
  return {
    ...actual,
    discoverHosts: () => discoverHosts(),
  };
});

const { ConnectScreen } = await import('./ConnectScreen.js');

function host(over: Partial<DiscoveredHost>): DiscoveredHost {
  return {
    code: '',
    hostName: 'Test Host',
    createdAt: Date.now(),
    viewers: 0,
    port: 8787,
    ...over,
  };
}

describe('ConnectScreen', () => {
  beforeEach(() => {
    discoverHosts.mockReset();
    discoverHosts.mockResolvedValue([]);
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* no storage in this environment */
    }
  });

  it('disables Connect until a valid 6–9 digit code is entered', () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    const button = screen.getByRole('button', { name: /connect/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByLabelText(/session code/i);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledWith('123456');
  });

  it('strips non-digits from the code input', () => {
    render(<ConnectScreen onConnect={vi.fn()} />);
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12ab34!56' } });
    expect(input.value).toBe('123456');
  });

  it('shows an error message when provided', () => {
    render(<ConnectScreen onConnect={vi.fn()} error="Host left the session." />);
    expect(screen.getByText(/host left the session/i)).toBeTruthy();
  });

  /** Find the "Connect" button rendered inside a discovered host row. */
  async function findHostRowButton(): Promise<HTMLButtonElement> {
    const row = await waitFor(() => {
      const el = document.querySelector('.host-row');
      if (!el) throw new Error('host row not rendered yet');
      return el as HTMLElement;
    });
    return row.querySelector('button') as HTMLButtonElement;
  }

  it('auto-connects when picking a discovered host with a valid code', async () => {
    discoverHosts.mockResolvedValue([host({ code: '987654', address: '192.168.1.50' })]);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.click(await findHostRowButton());
    expect(onConnect).toHaveBeenCalledWith('987654', 'ws://192.168.1.50:8787');
    // Field reflects the picked code too.
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    expect(input.value).toBe('987654');
  });

  it('threads the discovered host endpoint (address:port) through onConnect', async () => {
    // Regression for FINDING A: picking a host advertised on ANOTHER LAN machine
    // must connect to THAT host's signaling server, not the viewer's default
    // localhost endpoint — otherwise join fails with no-such-session.
    discoverHosts.mockResolvedValue([host({ code: '111222', address: '192.168.1.50', port: 8787 })]);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.click(await findHostRowButton());
    expect(onConnect).toHaveBeenCalledWith('111222', 'ws://192.168.1.50:8787');
  });

  it('omits the signaling override for a discovered host with no advertised address', async () => {
    // No address → fall back to the default (undefined override).
    discoverHosts.mockResolvedValue([host({ code: '333444', port: 8787 })]);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.click(await findHostRowButton());
    expect(onConnect).toHaveBeenCalledWith('333444', undefined);
  });

  it('manual code entry connects with no signaling override (uses the default)', async () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    const input = screen.getByLabelText(/session code/i);
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    // Manual entry passes only the code; App falls back to defaultSignalingUrl().
    expect(onConnect).toHaveBeenCalledWith('123456');
  });

  it('manual connect with a configured signaling host:port targets THAT server', () => {
    // Regression for FINDING P2: a viewer NOT served by the signaling machine
    // must be able to point a manual code at the right server. host:port is
    // normalized to a ws:// URL and threaded through onConnect.
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.change(screen.getByLabelText(/session code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/signaling server/i), {
      target: { value: '192.168.1.10:8787' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(onConnect).toHaveBeenCalledWith('123456', 'ws://192.168.1.10:8787');
  });

  it('manual connect with a full ws URL targets THAT server verbatim', () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.change(screen.getByLabelText(/session code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/signaling server/i), {
      target: { value: 'ws://192.168.1.10:8787' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(onConnect).toHaveBeenCalledWith('123456', 'ws://192.168.1.10:8787');
  });

  it('manual connect with an EMPTY signaling field omits the override (uses default)', () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.change(screen.getByLabelText(/session code/i), { target: { value: '123456' } });
    // Leave the signaling field blank.
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(onConnect).toHaveBeenCalledWith('123456');
    expect(onConnect.mock.calls[0]).toHaveLength(1);
  });

  it('persists the configured signaling server and restores it on next mount', () => {
    const first = render(<ConnectScreen onConnect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/session code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/signaling server/i), {
      target: { value: '192.168.1.10:8787' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    first.unmount();

    // Remount: the field is seeded from the persisted value.
    render(<ConnectScreen onConnect={vi.fn()} />);
    const restored = screen.getByLabelText(/signaling server/i) as HTMLInputElement;
    expect(restored.value).toBe('192.168.1.10:8787');
  });

  it('does NOT auto-connect on a host with an invalid (too-short) code; prefills+focuses the field', async () => {
    // Defense-in-depth: a discovered host advertising a bad code must not trigger
    // onConnect with it — that just fails confusingly. Instead the user is invited
    // to enter the code (field focused), with anything advertised prefilled.
    discoverHosts.mockResolvedValue([host({ code: '12' })]);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.click(await findHostRowButton());
    expect(onConnect).not.toHaveBeenCalled();
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The (too-short) advertised code is prefilled so the user can finish it.
    expect(input.value).toBe('12');
  });

  it('does NOT auto-connect with an empty code and leaves the field empty', async () => {
    discoverHosts.mockResolvedValue([host({ code: '' })]);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.click(await findHostRowButton());
    expect(onConnect).not.toHaveBeenCalled();
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    expect(input.value).toBe('');
  });
});
