/**
 * Regression test for the viewer audio mute/volume sync bug.
 *
 * Bug: after muting via the toolbar button, `toggleMute` sends
 * {t:'audio',enabled:false} and the host disables its audio track. If the
 * viewer then raised the volume slider above zero from that muted state, the
 * old code only flipped the local `muted` flag (`setMuted(false)`) and never
 * sent {t:'audio',enabled:true}. The UI showed unmuted while the host track
 * stayed disabled, so the session stayed silent.
 *
 * Fix: raising the volume above zero from a muted state must re-enable the host
 * audio track ({t:'audio',enabled:true}) AND clear the muted flag, keeping the
 * UI and the host track in sync. Muting must still send enabled:false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Capture the handlers passed to the (mocked) ViewerSession constructor so the
// test can drive the session into the `connected` state, and record every
// setAudioEnabled call to assert the wire-level {t:'audio',enabled} intent.
const setAudioEnabled = vi.fn<(enabled: boolean) => void>();
let capturedHandlers: Record<string, (...a: unknown[]) => void> = {};

vi.mock('./viewer-session.js', () => {
  class FakeViewerSession {
    constructor(opts: { handlers: Record<string, (...a: unknown[]) => void> }) {
      capturedHandlers = opts.handlers;
    }
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    requestMonitors = vi.fn();
    setAudioEnabled = setAudioEnabled;
  }
  return {
    ViewerSession: FakeViewerSession,
    defaultSignalingUrl: () => 'ws://localhost:8787',
  };
});

import { App } from './App.js';

async function connectAndReachStage(): Promise<void> {
  render(<App />);
  // Fill the connect screen and click Connect to instantiate the (mocked) session.
  const input = screen.getByLabelText('Session code') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(screen.getByText('Connect'));
    // Let the async connect() resolve and handlers register.
    await Promise.resolve();
  });
  // Drive the session to `connected`, which mounts the toolbar/video stage.
  await act(async () => {
    capturedHandlers.onState?.('connected');
  });
}

describe('viewer audio: re-enable host audio when volume unmutes (App.tsx)', () => {
  beforeEach(() => {
    setAudioEnabled.mockClear();
    capturedHandlers = {};
  });

  it('mute sends enabled:false, then raising the volume from muted sends enabled:true and unmutes', async () => {
    await connectAndReachStage();

    // The app starts muted (autoplay policy). Click mute toggle to unmute first
    // is not what we want; we want to exercise: mute -> raise volume.
    // Initial state is muted=true, so the toolbar shows "Unmute audio".
    const muteBtn = screen.getByLabelText('Unmute audio');

    // 1) Unmute via toggle so we can then re-mute through the toggle path,
    //    making the mute->slider sequence explicit and realistic.
    fireEvent.click(muteBtn); // muted: true -> false  => setAudioEnabled(true)
    expect(setAudioEnabled).toHaveBeenLastCalledWith(true);

    // 2) Mute via toggle: sends {t:'audio',enabled:false} (host disables track).
    const muteBtn2 = screen.getByLabelText('Mute audio');
    fireEvent.click(muteBtn2); // muted: false -> true => setAudioEnabled(false)
    expect(setAudioEnabled).toHaveBeenLastCalledWith(false);
    // UI is muted again.
    expect(screen.getByLabelText('Unmute audio')).toBeTruthy();

    setAudioEnabled.mockClear();

    // 3) Raise the volume slider above zero from the muted state. This must
    //    re-enable the host audio track AND clear the muted flag.
    const slider = screen.getByLabelText('Volume') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0.5' } });

    // The fix: a {t:'audio',enabled:true} frame is sent...
    expect(setAudioEnabled).toHaveBeenCalledWith(true);
    expect(setAudioEnabled).toHaveBeenCalledTimes(1);
    // ...and the UI reflects unmuted (button now offers to "Mute audio").
    expect(screen.getByLabelText('Mute audio')).toBeTruthy();
  });

  it('raising the volume when already unmuted does not spam audio-enable frames', async () => {
    await connectAndReachStage();

    // Unmute once.
    fireEvent.click(screen.getByLabelText('Unmute audio'));
    expect(setAudioEnabled).toHaveBeenLastCalledWith(true);
    setAudioEnabled.mockClear();

    // Now adjust volume while already unmuted: no further audio frame needed.
    const slider = screen.getByLabelText('Volume') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0.7' } });
    expect(setAudioEnabled).not.toHaveBeenCalled();
  });
});
