/**
 * App-level connection-consent / access-PIN UI tests.
 *
 * We mock the ViewerSession so we can drive the auth handlers (`onAuthRequired`,
 * `onAuthResult`) and lifecycle state directly, and assert the App renders the
 * right gate: a PIN field for `'pin'` modes, a "waiting for host approval" notice
 * for `'prompt'`, an "Access denied" retry on a denial, and that the video stage
 * stays gated until authorization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { AuthChallenge } from './viewer-session.js';

interface FakeSession {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  requestMonitors: ReturnType<typeof vi.fn>;
  submitPin: ReturnType<typeof vi.fn>;
  onState?: (s: string, detail?: string) => void;
  onAuthRequired?: (c: AuthChallenge) => void;
  onAuthResult?: (ok: boolean) => void;
}

const sessions: FakeSession[] = [];

vi.mock('./viewer-session.js', () => {
  class FakeViewerSession {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    requestMonitors = vi.fn();
    submitPin = vi.fn().mockResolvedValue(undefined);
    onState?: (s: string, detail?: string) => void;
    onAuthRequired?: (c: AuthChallenge) => void;
    onAuthResult?: (ok: boolean) => void;
    constructor(opts: {
      handlers: {
        onState?: (s: string, detail?: string) => void;
        onAuthRequired?: (c: AuthChallenge) => void;
        onAuthResult?: (ok: boolean) => void;
      };
    }) {
      this.onState = opts.handlers.onState;
      this.onAuthRequired = opts.handlers.onAuthRequired;
      this.onAuthResult = opts.handlers.onAuthResult;
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

describe('App auth gate (consent + PIN)', () => {
  beforeEach(() => {
    sessions.length = 0;
  });

  it('pin mode: renders a PIN field and submits the entered PIN', async () => {
    render(<App />);
    await submitConnect('123456');
    const session = sessions[0]!;

    await act(async () => {
      session.onAuthRequired?.({ mode: 'pin', needsPin: true });
      session.onState?.('authenticating');
    });

    const pinInput = screen.getByLabelText('Access PIN') as HTMLInputElement;
    expect(pinInput).toBeTruthy();

    fireEvent.change(pinInput, { target: { value: '824193' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
      await Promise.resolve();
    });
    expect(session.submitPin).toHaveBeenCalledWith('824193');
  });

  it('prompt mode: shows the waiting-for-approval notice and no PIN field', async () => {
    render(<App />);
    await submitConnect('123456');
    const session = sessions[0]!;

    await act(async () => {
      session.onAuthRequired?.({ mode: 'prompt', needsPin: false });
      session.onState?.('authenticating');
    });

    expect(screen.getByText('Waiting for host approval…')).toBeTruthy();
    expect(screen.queryByLabelText('Access PIN')).toBeNull();
    expect(session.submitPin).not.toHaveBeenCalled();
  });

  it('denial surfaces "Access denied" with a retry, then success clears the gate', async () => {
    render(<App />);
    await submitConnect('123456');
    const session = sessions[0]!;

    await act(async () => {
      session.onAuthRequired?.({ mode: 'pin', needsPin: true });
      session.onState?.('authenticating');
    });
    await act(async () => {
      session.onAuthResult?.(false);
      session.onState?.('denied');
    });

    expect(screen.getByRole('alert').textContent).toMatch(/Access denied/i);
    // Retry affordance: the PIN field is still present to re-enter.
    expect(screen.getByLabelText('Access PIN')).toBeTruthy();

    // Authorization succeeds: the gate is dismissed.
    await act(async () => {
      session.onAuthResult?.(true);
      session.onState?.('connected');
    });
    expect(screen.queryByLabelText('Access PIN')).toBeNull();
  });

  it('P2-1: prompt-mode challenge renders the waiting overlay with NO PIN field', async () => {
    render(<App />);
    await submitConnect('123456');
    const session = sessions[0]!;

    await act(async () => {
      // The host sends a prompt-mode challenge BEFORE running consent, flipping
      // the viewer into the waiting state (no PIN to enter).
      session.onAuthRequired?.({ mode: 'prompt', needsPin: false });
      session.onState?.('authenticating');
    });

    expect(screen.getByText('Waiting for host approval…')).toBeTruthy();
    expect(screen.queryByLabelText('Access PIN')).toBeNull();
    expect(screen.queryByText('Connect')).toBeNull();

    // A prompt-mode denial is terminal (no PIN to retry): surface it.
    await act(async () => {
      session.onAuthResult?.(false);
      session.onState?.('denied');
    });
    expect(screen.getByText('Connection declined')).toBeTruthy();
    expect(screen.queryByLabelText('Access PIN')).toBeNull();
  });

  it('P2-2: after a wrong PIN the Retry button is DISABLED until a fresh challenge arrives, then re-enabled', async () => {
    render(<App />);
    await submitConnect('123456');
    const session = sessions[0]!;

    await act(async () => {
      session.onAuthRequired?.({ mode: 'pin', needsPin: true });
      session.onState?.('authenticating');
    });

    const pinInput = screen.getByLabelText('Access PIN') as HTMLInputElement;
    fireEvent.change(pinInput, { target: { value: '000000' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
      await Promise.resolve();
    });
    expect(session.submitPin).toHaveBeenCalledTimes(1);

    // Host rejects. The consumed challenge is dropped; Retry must be inert until
    // a fresh challenge re-arms the gate.
    await act(async () => {
      session.onAuthResult?.(false);
      session.onState?.('denied');
    });
    const retryDisabled = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(retryDisabled.disabled).toBe(true);
    // The PIN field is also disabled while disarmed (nothing to submit against).
    expect((screen.getByLabelText('Access PIN') as HTMLInputElement).disabled).toBe(true);

    // Clicking the disabled Retry submits nothing (proof never recomputed against
    // the consumed nonce).
    await act(async () => {
      fireEvent.click(retryDisabled);
      await Promise.resolve();
    });
    expect(session.submitPin).toHaveBeenCalledTimes(1);

    // Host re-issues a FRESH challenge (new nonce) -> onAuthRequired fires again,
    // re-arming the gate. Retry becomes active while the error persists.
    await act(async () => {
      session.onAuthRequired?.({ mode: 'pin', needsPin: true });
      session.onState?.('authenticating');
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Incorrect PIN/i);
    const retryArmed = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    const armedInput = screen.getByLabelText('Access PIN') as HTMLInputElement;
    expect(armedInput.disabled).toBe(false);
    fireEvent.change(armedInput, { target: { value: '824193' } });
    expect(retryArmed.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(retryArmed);
      await Promise.resolve();
    });
    // The resubmit goes through now that a fresh challenge is armed.
    expect(session.submitPin).toHaveBeenCalledTimes(2);
    expect(session.submitPin).toHaveBeenLastCalledWith('824193');
  });

  it('open mode: no challenge — no auth gate is ever shown', async () => {
    render(<App />);
    await submitConnect('123456');
    const session = sessions[0]!;
    await act(async () => {
      session.onState?.('connected');
    });
    expect(screen.queryByLabelText('Access PIN')).toBeNull();
    expect(screen.queryByText('Waiting for host approval…')).toBeNull();
  });
});
