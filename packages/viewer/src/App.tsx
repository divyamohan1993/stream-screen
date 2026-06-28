import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CTRL_ALT_DEL,
  SPECIAL_KEYS,
  parseIceServers,
  type AdaptiveDecision,
  type AdaptiveStats,
  type InputEvent,
  type MonitorInfo,
  type FileMeta,
} from '@stream-screen/core';
import { ConnectScreen } from './components/ConnectScreen.js';
import { Toolbar } from './components/Toolbar.js';
import { StatsPanel } from './components/StatsPanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { FileTransferPanel } from './components/FileTransferPanel.js';
import { AuthPrompt } from './components/AuthPrompt.js';
import { VideoStage, type VideoStageHandle } from './components/VideoStage.js';
import {
  ViewerSession,
  defaultSignalingUrl,
  type AuthChallenge,
  type ChatEntry,
  type FileTransferEntry,
  type SessionState,
} from './viewer-session.js';
import { controllerForPreset, type QualityPreset } from './quality.js';
import { useRecorder } from './use-recorder.js';

/** Trigger a browser download of raw bytes assembled from an inbound transfer. */
function downloadBytes(data: Uint8Array, meta: FileMeta): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
  // Copy into a fresh ArrayBuffer-backed view so the Blob ctor's BlobPart type
  // is satisfied regardless of the source buffer kind (Shared/ArrayBuffer).
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const blob = new Blob([bytes.buffer], { type: meta.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = meta.name || 'download';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Root viewer app. Owns the {@link ViewerSession} lifecycle and wires the
 * connect screen, video stage, toolbar, live stats panel, chat, file transfer,
 * multi-monitor switching, recording, audio, and special keys together.
 *
 * No timers end the session and no caps are imposed — StreamScreen is always
 * free and unlimited.
 */
export function App(): React.JSX.Element {
  const [state, setState] = useState<SessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<AdaptiveStats | null>(null);
  const [decision, setDecision] = useState<AdaptiveDecision | null>(null);
  const [preset, setPreset] = useState<QualityPreset>('Auto');
  const [statsVisible, setStatsVisible] = useState(true);
  // Rolling end-to-end interactive latency history (rtt + playout), newest last,
  // for the StatsPanel sparkline. Capped so it never grows unbounded.
  const [latencyHistory, setLatencyHistory] = useState<number[]>([]);

  // Audio (A)
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);

  // Chat (E)
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [chatVisible, setChatVisible] = useState(false);

  // File transfer (B)
  const [transfers, setTransfers] = useState<FileTransferEntry[]>([]);
  const [filesVisible, setFilesVisible] = useState(false);

  // Multi-monitor (C)
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [activeMonitorId, setActiveMonitorId] = useState<string | null>(null);

  // Connection consent / access PIN. `authChallenge` is set while the host's
  // auth handshake is pending (null in 'open' mode); `authDenied` surfaces a
  // reason-free denial with a retry; `authSubmitting` disables the field while a
  // PIN proof is being derived/verified.
  const [authChallenge, setAuthChallenge] = useState<AuthChallenge | null>(null);
  const [authDenied, setAuthDenied] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const sessionRef = useRef<ViewerSession | null>(null);
  const stageRef = useRef<VideoStageHandle>(null);
  const controllerRef = useRef(controllerForPreset('Auto'));

  // Recording (D)
  const recorder = useRecorder({ stream });

  // Show the live stage once we've joined the room. Keep it up during a
  // reconnect so the user sees the (frozen) last frame plus the reconnecting
  // pill rather than being bounced back to the connect screen. The auth-gated
  // states ('authenticating'/'denied') also live on the stage so the consent/PIN
  // overlay renders above it while the video stays withheld.
  const onStage =
    state === 'waiting-for-host' ||
    state === 'connected' ||
    state === 'reconnecting' ||
    state === 'authenticating' ||
    state === 'denied';

  /** Max number of latency samples retained for the sparkline. */
  const LATENCY_HISTORY_LIMIT = 60;

  const handleStats = useCallback((s: AdaptiveStats) => {
    setStats(s);
    if (s.width > 0 || s.fps > 0 || s.availableKbps > 0) {
      setDecision(controllerRef.current.update(s));
    }
    // Track end-to-end interactive latency (network rtt + receiver playout) for
    // the sparkline. Only record real samples (a frame is flowing).
    if (s.rttMs > 0 || (s.playoutMs ?? 0) > 0) {
      const latency = s.rttMs + (s.playoutMs ?? 0);
      setLatencyHistory((prev) => {
        const next = prev.length >= LATENCY_HISTORY_LIMIT ? prev.slice(1) : prev.slice();
        next.push(latency);
        return next;
      });
    }
  }, []);

  /** Merge or append a transfer entry by id (progress updates patch in place). */
  const upsertTransfer = useCallback((entry: FileTransferEntry) => {
    setTransfers((prev) => {
      const idx = prev.findIndex((t) => t.id === entry.id);
      if (idx === -1) return [entry, ...prev];
      const next = prev.slice();
      const existing = next[idx];
      next[idx] = {
        ...existing,
        ...entry,
        // Preserve name/size/mime once known (later progress events omit them).
        name: entry.name || existing.name,
        size: entry.size || existing.size,
        mime: entry.mime || existing.mime,
      };
      return next;
    });
  }, []);

  const connect = useCallback(
    async (code: string, signalingUrl?: string, iceServers?: string) => {
      // Tear down any existing session BEFORE creating a new one. Otherwise a
      // failed/old session lingers — its SignalingClient keeps reconnecting and
      // replaying its remembered join, and its stats loop keeps running — while
      // sessionRef is overwritten and can never disconnect it. Disconnecting
      // first guarantees at most one live session.
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      setError(null);
      setChatMessages([]);
      setTransfers([]);
      setMonitors([]);
      setActiveMonitorId(null);
      setLatencyHistory([]);
      setAuthChallenge(null);
      setAuthDenied(false);
      setAuthSubmitting(false);
      // Parse any advanced local STUN/TURN override the user typed into the
      // ConnectScreen. parseIceServers NEVER throws — garbage/empty → []. An
      // empty list is passed as undefined so it counts as "no local override"
      // and the server-distributed list from the `joined` ack (when present) is
      // used instead. Both empty → LAN-only default, unchanged.
      const parsedIce = iceServers ? parseIceServers(iceServers) : [];
      const session = new ViewerSession({
        code,
        // When a discovered host was picked, connect to ITS signaling server
        // (its advertised address:port); manual code entry has no override and
        // falls back to the viewer's default endpoint.
        signalingUrl: signalingUrl ?? defaultSignalingUrl(),
        iceServers: parsedIce.length > 0 ? parsedIce : undefined,
        handlers: {
          onState: (st, detail) => {
            // DEFENSE IN DEPTH against superseded connects (FINDING P2): only the
            // CURRENT session may drive global UI state. If the user retried or
            // picked another host, App constructed a newer session and overwrote
            // sessionRef; a late state event from THIS (now-stale) session must be
            // ignored so a canceled attempt's 'error' can never overwrite the newer
            // session's connecting/connected state and bounce the UI back to error.
            if (sessionRef.current !== session) return;
            setState(st);
            if (st === 'error') setError(detail ?? 'Connection error');
            // On connect, ask the host for its monitor list.
            if (st === 'connected') session.requestMonitors();
          },
          onStream: (s) => setStream(s),
          onStats: handleStats,
          onClipboard: (text) => {
            void stageRef.current?.capture?.applyClipboardFromHost(text);
          },
          onChat: (entry) => setChatMessages((prev) => [...prev, entry]),
          onMonitors: (list) => setMonitors(list),
          onMonitorSwitched: (id) => setActiveMonitorId(id),
          onFileTransfer: upsertTransfer,
          onFileReady: (data, meta) => downloadBytes(data, meta),
          onAuthRequired: (challenge) => {
            if (sessionRef.current !== session) return;
            // A fresh challenge clears any prior denial and in-flight state.
            setAuthChallenge(challenge);
            setAuthDenied(false);
            setAuthSubmitting(false);
          },
          onAuthResult: (ok) => {
            if (sessionRef.current !== session) return;
            setAuthSubmitting(false);
            if (ok) {
              // Authorized: drop the gate; the session releases the video and
              // advances to 'connected'.
              setAuthChallenge(null);
              setAuthDenied(false);
            } else {
              setAuthDenied(true);
            }
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
    [handleStats, upsertTransfer],
  );

  const disconnect = useCallback(() => {
    if (recorder.recording) recorder.stop();
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setStream(null);
    setStats(null);
    setDecision(null);
    setState('idle');
    setError(null);
    setChatMessages([]);
    setTransfers([]);
    setMonitors([]);
    setActiveMonitorId(null);
    setLatencyHistory([]);
    setAuthChallenge(null);
    setAuthDenied(false);
    setAuthSubmitting(false);
  }, [recorder]);

  // Submit a PIN in response to the host's auth challenge. The session derives
  // the proof and never stores the PIN; we only flip the submitting flag for UI.
  const submitPin = useCallback((pin: string) => {
    const session = sessionRef.current;
    if (!session) return;
    setAuthDenied(false);
    setAuthSubmitting(true);
    void session.submitPin(pin).catch(() => {
      // Derivation/transport failure: drop the spinner so the user can retry.
      setAuthSubmitting(false);
    });
  }, []);

  const sendInput = useCallback((e: InputEvent) => {
    sessionRef.current?.sendInput(e);
  }, []);

  const onPreset = useCallback((p: QualityPreset) => {
    setPreset(p);
    controllerRef.current = controllerForPreset(p);
    // Tell the host to apply the requested quality ceiling over the control
    // channel; its authoritative adaptive controller acts on it.
    sessionRef.current?.setQuality(p);
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

  // Audio (A): toggling mute is a user gesture, satisfying autoplay-with-sound.
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      sessionRef.current?.setAudioEnabled(!next);
      return next;
    });
  }, []);

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    // Adjusting volume above zero implies the user wants to hear audio. If we
    // were muted, a prior `toggleMute` told the host to disable its audio track
    // ({t:'audio',enabled:false}); flipping only the local `muted` flag here
    // would leave the UI unmuted while the host track stays disabled and the
    // session silent. So when unmuting via the slider, also re-enable the host
    // audio track ({t:'audio',enabled:true}) to keep UI and host in sync.
    if (v > 0) {
      setMuted((m) => {
        if (m) sessionRef.current?.setAudioEnabled(true);
        return false;
      });
    }
  }, []);

  // Recording (D)
  const toggleRecording = useCallback(() => {
    if (recorder.recording) recorder.stop();
    else recorder.start(stream);
  }, [recorder, stream]);

  // Special keys (F)
  const sendCtrlAltDel = useCallback(() => {
    sessionRef.current?.sendInputSequence(CTRL_ALT_DEL);
  }, []);
  const sendWinKey = useCallback(() => {
    sessionRef.current?.sendInputSequence(SPECIAL_KEYS.WIN);
  }, []);

  // Chat (E)
  const sendChat = useCallback((text: string) => {
    sessionRef.current?.sendChat(text);
  }, []);

  // File transfer (B): read the File then hand bytes to the session.
  const sendFile = useCallback((file: File) => {
    const session = sessionRef.current;
    if (!session) return;
    void file.arrayBuffer().then((buf) => {
      session.sendFile(
        { name: file.name, size: file.size, type: file.type },
        new Uint8Array(buf),
      );
    });
  }, []);

  // Multi-monitor (C)
  const switchMonitor = useCallback((id: string) => {
    sessionRef.current?.switchMonitor(id);
    // Optimistically reflect the selection; confirmed by `monitor-switched`.
    setActiveMonitorId(id);
  }, []);
  const refreshMonitors = useCallback(() => {
    sessionRef.current?.requestMonitors();
  }, []);

  // Stop any in-flight recording if we lose the stage.
  useEffect(() => {
    if (!onStage && recorder.recording) recorder.stop();
  }, [onStage, recorder]);

  // Human-readable connection status announced to assistive technology via an
  // aria-live region whenever the session state changes.
  const connectionStatus =
    state === 'connected'
      ? 'Connected to host.'
      : state === 'connecting'
        ? 'Connecting to host…'
        : state === 'waiting-for-host'
          ? 'Waiting for the host to share their screen…'
          : state === 'reconnecting'
            ? 'Connection lost. Reconnecting…'
            : state === 'authenticating'
              ? authChallenge?.needsPin
                ? 'Authorization required. Enter the access PIN.'
                : 'Waiting for the host to approve your connection…'
              : state === 'denied'
                ? 'Access denied.'
                : state === 'disconnected'
                  ? 'Disconnected.'
                  : state === 'error'
                    ? `Connection error${error ? `: ${error}` : ''}.`
                    : 'Idle.';

  if (!onStage) {
    return (
      <div className="app">
        <span className="sr-only" role="status" aria-live="polite">
          {connectionStatus}
        </span>
        <main aria-label="Connect to a host">
          <ConnectScreen onConnect={connect} error={error} connecting={state === 'connecting'} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <span className="sr-only" role="status" aria-live="polite">
        {connectionStatus}
      </span>
      <Toolbar
        state={state}
        preset={preset}
        onPreset={onPreset}
        onToggleFullscreen={toggleFullscreen}
        onTogglePointerLock={togglePointerLock}
        onToggleStats={() => setStatsVisible((v) => !v)}
        onDisconnect={disconnect}
        statsVisible={statsVisible}
        muted={muted}
        volume={volume}
        onToggleMute={toggleMute}
        onVolume={onVolume}
        recording={recorder.recording}
        recordingSupported={recorder.state !== 'unsupported'}
        onToggleRecording={toggleRecording}
        onCtrlAltDel={sendCtrlAltDel}
        onWinKey={sendWinKey}
        onToggleChat={() => setChatVisible((v) => !v)}
        onToggleFiles={() => setFilesVisible((v) => !v)}
        chatVisible={chatVisible}
        filesVisible={filesVisible}
        monitors={monitors}
        activeMonitorId={activeMonitorId}
        onSwitchMonitor={switchMonitor}
        onRefreshMonitors={refreshMonitors}
      />
      <VideoStage
        ref={stageRef}
        stream={stream}
        onInput={sendInput}
        connected={state === 'connected'}
        muted={muted}
        volume={volume}
      >
        {authChallenge && (state === 'authenticating' || state === 'denied') && (
          <AuthPrompt
            challenge={authChallenge}
            denied={authDenied}
            submitting={authSubmitting}
            onSubmitPin={submitPin}
            onCancel={disconnect}
          />
        )}
        {statsVisible && (
          <StatsPanel stats={stats} decision={decision} latencyHistory={latencyHistory} />
        )}
        <div className="side-panels">
          {chatVisible && (
            <ChatPanel
              messages={chatMessages}
              onSend={sendChat}
              onClose={() => setChatVisible(false)}
            />
          )}
          {filesVisible && (
            <FileTransferPanel
              transfers={transfers}
              onSendFile={sendFile}
              onClose={() => setFilesVisible(false)}
            />
          )}
        </div>
      </VideoStage>
    </div>
  );
}
