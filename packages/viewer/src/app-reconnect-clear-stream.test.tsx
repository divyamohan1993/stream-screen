/**
 * Regression for P2-2 (App must clear prior media on (re)connect and ignore media
 * events from a superseded session).
 *
 * Connecting to another host after a prior successful session previously cleared
 * chat/transfers but LEFT the old `stream` (and stale stats/decision) in React
 * state. When the new session reached `waiting-for-host` / an auth gate, VideoStage
 * received the non-null OLD stream, suppressed its waiting overlay, and could show
 * the PREVIOUS host's screen while inputs were wired to the NEW session.
 *
 * Fix (App): connect() clears stream/stats/decision (and the latency sparkline)
 * so a new/reconnecting session never shows the prior host's stream while waiting
 * or auth-gated; and the onStream/onStats handlers are GUARDED to ignore events
 * from a session that is no longer sessionRef.current (the superseded-session
 * pattern already used for onState).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { AdaptiveStats } from '@stream-screen/core';

interface FakeHandlers {
  onState?: (s: string, detail?: string) => void;
  onStream?: (s: MediaStream) => void;
  onStats?: (s: AdaptiveStats) => void;
}

interface FakeSession extends FakeHandlers {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  requestMonitors: ReturnType<typeof vi.fn>;
}

const sessions: FakeSession[] = [];

vi.mock('./viewer-session.js', () => {
  class FakeViewerSession {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    requestMonitors = vi.fn();
    onState?: (s: string, detail?: string) => void;
    onStream?: (s: MediaStream) => void;
    onStats?: (s: AdaptiveStats) => void;
    constructor(opts: { handlers: FakeHandlers }) {
      this.onState = opts.handlers.onState;
      this.onStream = opts.handlers.onStream;
      this.onStats = opts.handlers.onStats;
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

function fakeStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

function fakeStats(over: Partial<AdaptiveStats> = {}): AdaptiveStats {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    availableKbps: 5000,
    rttMs: 20,
    playoutMs: 10,
    lossPct: 0,
    jitterMs: 0,
    ...over,
  } as AdaptiveStats;
}

describe('App clears prior media on (re)connect (P2-2)', () => {
  beforeEach(() => {
    sessions.length = 0;
  });

  it('a new connect clears the old stream (VideoStage shows the waiting overlay, not prior video)', async () => {
    render(<App />);

    // First session reaches connected WITH a stream.
    await submitConnect('123456');
    const first = sessions[0]!;
    await act(async () => {
      first.onState?.('connected');
      first.onStream?.(fakeStream('host-A'));
    });
    // The stage is showing video: no waiting overlay.
    expect(screen.queryByText('Waiting for host…')).toBeNull();

    // The session then hard-FAILS (e.g. host vanished): the App returns to the
    // connect screen ('error' is not an on-stage state) but the prior `stream`
    // stays in React state (the error path doesn't clear media). This is the
    // stale-stream setup for P2-2: a fresh connect from here must NOT show host-A.
    await act(async () => {
      first.onState?.('error', 'host gone');
    });
    expect(screen.getByLabelText('Session code')).toBeTruthy();

    // Connect to ANOTHER host. The new session is constructed; until it delivers
    // its own stream it sits at waiting-for-host, and the OLD stream must be gone.
    await submitConnect('654321');
    expect(sessions).toHaveLength(2);
    const second = sessions[1]!;
    await act(async () => {
      second.onState?.('waiting-for-host');
    });

    // The previous host's video is cleared: VideoStage renders the waiting
    // overlay rather than the stale stream.
    expect(screen.getByText('Waiting for host…')).toBeTruthy();
  });

  it('an onStream from a SUPERSEDED session is ignored (does not overwrite current media)', async () => {
    render(<App />);

    await submitConnect('123456');
    const first = sessions[0]!;
    await act(async () => {
      first.onState?.('error', 'no-such-session');
    });

    // Newer session becomes current and reaches waiting-for-host (no stream yet).
    await submitConnect('654321');
    const second = sessions[1]!;
    await act(async () => {
      second.onState?.('waiting-for-host');
    });
    expect(screen.getByText('Waiting for host…')).toBeTruthy();

    // A LATE onStream from the OLD, superseded session #0 must be IGNORED — it
    // must not paint the prior host's stream over the current waiting session.
    await act(async () => {
      first.onStream?.(fakeStream('stale-host'));
    });
    expect(screen.getByText('Waiting for host…')).toBeTruthy();

    // The CURRENT session's own stream IS honored.
    await act(async () => {
      second.onState?.('connected');
      second.onStream?.(fakeStream('host-B'));
    });
    expect(screen.queryByText('Waiting for host…')).toBeNull();
  });

  it('an onStats from a SUPERSEDED session is ignored (does not feed the dashboard)', async () => {
    render(<App />);

    await submitConnect('123456');
    const first = sessions[0]!;
    await act(async () => {
      first.onState?.('error', 'first-failed');
    });

    await submitConnect('654321');
    const second = sessions[1]!;
    await act(async () => {
      second.onState?.('connected');
      second.onStream?.(fakeStream('host-B'));
      // Current session reports its real resolution.
      second.onStats?.(fakeStats({ width: 1280, height: 720 }));
    });
    // The stats panel reflects the CURRENT session's resolution.
    expect(screen.getByText(/1280×720|1280x720|1280/)).toBeTruthy();

    // A LATE onStats from the superseded session must NOT overwrite it.
    await act(async () => {
      first.onStats?.(fakeStats({ width: 640, height: 480 }));
    });
    expect(screen.queryByText(/640×480|640x480/)).toBeNull();
  });
});
