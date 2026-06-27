import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DiscoveredHost } from '../discovery-client.js';

// Drive the discovery path with controlled hosts so we can exercise pick().
const discoverHosts = vi.fn<() => Promise<DiscoveredHost[]>>();
vi.mock('../discovery-client.js', () => ({
  discoverHosts: () => discoverHosts(),
}));

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
    discoverHosts.mockResolvedValue([host({ code: '987654' })]);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.click(await findHostRowButton());
    expect(onConnect).toHaveBeenCalledWith('987654');
    // Field reflects the picked code too.
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    expect(input.value).toBe('987654');
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
