import React, { useCallback, useRef, useState } from 'react';
import type { AdaptiveDecision, AdaptiveStats, InputEvent } from '@stream-screen/core';
import { ConnectScreen } from './components/ConnectScreen.js';
import { Toolbar } from './components/Toolbar.js';
import { StatsPanel } from './components/StatsPanel.js';
import { VideoStage, type VideoStageHandle } from './components/VideoStage.js';
import {
  ViewerSession,
  defaultSignalingUrl,
  type SessionState,
} from './viewer-session.js';
import { controllerForPreset, type QualityPreset } from './quality.js';

/**
 * Root viewer app. Owns the {@link ViewerSession} lifecycle and wires the
 * connect screen, video stage, toolbar, and live stats panel together.
 *
 * The viewer-side {@link controllerForPreset} mirror runs purely to surface the
 * adaptive decision *reason* in the UI; the host owns the authoritative
 * encoding decisions. No timers end the session and no caps are imposed —
 * StreamScreen is always free and unlimited.
 */
export function App(): React.JSX.Element {
  const [state, setState] = useState<SessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<AdaptiveStats | null>(null);
  const [decision, setDecision] = useState<AdaptiveDecision | null>(null);
  const [preset, setPreset] = useState<QualityPreset>('Auto');
  const [statsVisible, setStatsVisible] = useState(true);

  const sessionRef = useRef<ViewerSession | null>(null);
  const stageRef = useRef<VideoStageHandle>(null);
  const controllerRef = useRef(controllerForPreset('Auto'));

  // Show the live stage only once we've joined the room; the connect screen
  // stays up through 'connecting' (button spinner) and 'error' (retry).
  const onStage = state === 'waiting-for-host' || state === 'connected';

  const handleStats = useCallback((s: AdaptiveStats) => {
    setStats(s);
    // Mirror the adaptive engine client-side to display its reasoning. Only
    // feed real samples (a connected link reports nonzero resolution/fps).
    if (s.width > 0 || s.fps > 0 || s.availableKbps > 0) {
      setDecision(controllerRef.current.update(s));
    }
  }, []);

  const connect = useCallback(
    async (code: string) => {
      setError(null);
      const session = new ViewerSession({
        code,
        signalingUrl: defaultSignalingUrl(),
        handlers: {
          onState: (st, detail) => {
            setState(st);
            if (st === 'error') setError(detail ?? 'Connection error');
          },
          onStream: (s) => setStream(s),
          onStats: handleStats,
          onClipboard: (text) => {
            void stageRef.current?.capture?.applyClipboardFromHost(text);
          },
        },
      });
      sessionRef.current = session;
      try {
        await session.connect();
      } catch {
        /* state/error already surfaced via handlers */
      }
    },
    [handleStats],
  );

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setStream(null);
    setStats(null);
    setDecision(null);
    setState('idle');
    setError(null);
  }, []);

  const sendInput = useCallback((e: InputEvent) => {
    sessionRef.current?.sendInput(e);
  }, []);

  const onPreset = useCallback((p: QualityPreset) => {
    setPreset(p);
    controllerRef.current = controllerForPreset(p);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void stageRef.current?.exitFullscreen();
    } else {
      void stageRef.current?.requestFullscreen();
    }
  }, []);

  const togglePointerLock = useCallback(() => {
    if (typeof document !== 'undefined' && document.pointerLockElement) {
      stageRef.current?.exitPointerLock();
    } else {
      stageRef.current?.requestPointerLock();
    }
  }, []);

  if (!onStage) {
    return (
      <div className="app">
        <ConnectScreen onConnect={connect} error={error} connecting={state === 'connecting'} />
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar
        state={state}
        preset={preset}
        onPreset={onPreset}
        onToggleFullscreen={toggleFullscreen}
        onTogglePointerLock={togglePointerLock}
        onToggleStats={() => setStatsVisible((v) => !v)}
        onDisconnect={disconnect}
        statsVisible={statsVisible}
      />
      <VideoStage
        ref={stageRef}
        stream={stream}
        onInput={sendInput}
        connected={state === 'connected'}
      >
        {statsVisible && <StatsPanel stats={stats} decision={decision} />}
      </VideoStage>
    </div>
  );
}
