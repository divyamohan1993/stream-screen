/**
 * Regression for FINDING P2 (App must not let a failed/old session linger).
 *
 * Previously a later connect attempt in App overwrote `sessionRef` WITHOUT
 * disconnecting the old one, so a rejected/old ViewerSession lingered — its
 * SignalingClient kept reconnecting and replaying its remembered join, and its
 * stats loop kept running — with no handle left to stop it.
 *
 * Fix: App.connect() DISCONNECTS any existing session before constructing a new
 * one, so at most one live session exists at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

interface FakeSession {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  requestMonitors: ReturnType<typeof vi.fn>;
  onState?: (s: string, detail?: string) => void;
}

const sessions: FakeSession[] = [];

vi.mock('./viewer-session.js', () => {
  class FakeViewerSession {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    requestMonitors = vi.fn();
    onState?: (s: string, detail?: string) => void;
    constructor(opts: { handlers: { onState?: (s: string, detail?: string) => void } }) {
      this.onState = opts.handlers.onState;
      sessions.push(this as unknown as FakeSession);
    }
  }
  return {
    ViewerSession: FakeViewerSession,
    defaultSignalingUrl: () => 'ws://localhost:8787',
  };
});

import { App } from './App.js';

async function submitConnect(code: string): Promise<void> {
  const input = screen.getByLabelText('Session code') as HTMLInputElement;
  fireEvent.change(input, { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByText('Connect'));
    await Promise.resolve();
  });
}

describe('App connect lifecycle (FINDING P2)', () => {
  beforeEach(() => {
    sessions.length = 0;
  });

  it('a second connect disconnects the first session before creating a new one', async () => {
    render(<App />);

    // First connect — instantiates session #0.
    await submitConnect('123456');
    expect(sessions).toHaveLength(1);
    const first = sessions[0]!;
    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(first.disconnect).not.toHaveBeenCalled();

    // Drive it to `error` so we stay on the connect screen and can retry.
    await act(async () => {
      first.onState?.('error', 'no-such-session');
    });

    // Second connect — must disconnect the FIRST session before constructing #1.
    await submitConnect('654321');
    expect(sessions).toHaveLength(2);
    const second = sessions[1]!;
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second.connect).toHaveBeenCalledTimes(1);
  });
});
