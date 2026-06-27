/**
 * Regression for FINDING P2 (App must ignore state events from a superseded
 * session).
 *
 * If the user retries or picks another host while a previous connect() is still
 * awaiting, App constructs a NEWER session and overwrites sessionRef. A late
 * state event (e.g. 'error') from the OLD, canceled session must be IGNORED so it
 * cannot overwrite the newer session's connecting/connected state and bounce the
 * UI back to the connect screen showing an error.
 *
 * Fix (layer 2, in App): the onState handler applies updates only when the
 * emitting session is still sessionRef.current.
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
    // connect() resolves immediately; state is driven manually via onState in
    // the test so we control event ordering across superseded sessions.
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

describe('App ignores superseded session state (FINDING P2)', () => {
  beforeEach(() => {
    sessions.length = 0;
  });

  it('a state event from a non-current session does not overwrite the newer session state', async () => {
    render(<App />);

    // First connect → session #0.
    await submitConnect('123456');
    expect(sessions).toHaveLength(1);
    const first = sessions[0]!;

    // Drive #0 to 'error' so we remain on the connect screen and can retry.
    await act(async () => {
      first.onState?.('error', 'no-such-session');
    });
    expect(screen.getByText('no-such-session')).toBeTruthy();

    // Second connect → session #1 becomes the current session.
    await submitConnect('654321');
    expect(sessions).toHaveLength(2);
    const second = sessions[1]!;

    // The newer (current) session advances to connected: UI shows the stage.
    await act(async () => {
      second.onState?.('connected');
    });
    // On 'connected' App asks the current session for monitors.
    expect(second.requestMonitors).toHaveBeenCalled();

    // NOW a LATE, stale 'error' arrives from the OLD, superseded session #0.
    await act(async () => {
      first.onState?.('error', 'stale failure');
    });

    // It must be ignored: the newer session's 'connected' state is preserved.
    // The stale error message is NOT surfaced, and we did NOT bounce back to the
    // connect screen (the session code input only exists on the connect screen).
    expect(screen.queryByText('stale failure')).toBeNull();
    expect(screen.queryByLabelText('Session code')).toBeNull();
  });
});
