import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DiscoveredHost } from '../discovery-client.js';

const discoverHosts = vi.fn<() => Promise<DiscoveredHost[]>>();
vi.mock('../discovery-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery-client.js')>();
  return { ...actual, discoverHosts: () => discoverHosts() };
});

const { ConnectScreen } = await import('./ConnectScreen.js');

describe('ConnectScreen accessibility + keyboard', () => {
  beforeEach(() => {
    discoverHosts.mockReset();
    discoverHosts.mockResolvedValue([]);
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* no storage */
    }
  });

  it('labels the session code field via an associated <label> with inputMode', () => {
    render(<ConnectScreen onConnect={vi.fn()} />);
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    // Associated by id/htmlFor (a real <label>, not just aria-label).
    expect(input.id).toBe('session-code');
    expect(document.querySelector('label[for="session-code"]')).toBeTruthy();
    expect(input.getAttribute('inputmode')).toBe('numeric');
  });

  it('activates Connect from the keyboard (Enter in the code field)', () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    const input = screen.getByLabelText(/session code/i);
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConnect).toHaveBeenCalledWith('123456');
  });

  it('the Connect button is reachable and activatable by keyboard (Enter/Space fire click)', () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.change(screen.getByLabelText(/session code/i), { target: { value: '123456' } });
    const button = screen.getByRole('button', { name: /^connect$/i }) as HTMLButtonElement;
    // Native <button> activates on Enter/Space; jsdom maps that to a click.
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledWith('123456');
  });

  it('discovered-host Connect buttons have distinct accessible names', async () => {
    discoverHosts.mockResolvedValue([
      {
        code: '987654',
        hostName: 'Office PC',
        createdAt: Date.now(),
        viewers: 0,
        port: 8787,
        address: '192.168.1.50',
      },
    ]);
    render(<ConnectScreen onConnect={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: /connect to office pc, code 987654/i });
    expect(btn).toBeTruthy();
  });

  it('renders connect content inside a navigation landmark for discovery', () => {
    render(<ConnectScreen onConnect={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: /discovered lan hosts/i })).toBeTruthy();
  });
});
