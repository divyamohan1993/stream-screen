import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CTRL_ALT_DEL,
  SPECIAL_KEYS,
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
import { VideoStage, type VideoStageHandle } from './components/VideoStage.js';
import {
  ViewerSession,
  defaultSignalingUrl,
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

  const sessionRef = useRef<ViewerSession | null>(null);
  const stageRef = useRef<VideoStageHandle>(null);
  const controllerRef = useRef(controllerForPreset('Auto'));

  // Recording (D)
  const recorder = useRecorder({ stream });

  // Show the live stage once we've joined the room. Keep it up during a
  // reconnect so the user sees the (frozen) last frame plus the reconnecting
  // pill rather than being bounced back to the connect screen.
  const onStage =
    state === 'waiting-for-host' || state === 'connected' || state === 'reconnecting';

  const handleStats = useCallback((s: AdaptiveStats) => {
    setStats(s);
    if (s.width > 0 || s.fps > 0 || s.availableKbps > 0) {
      setDecision(controllerRef.current.update(s));
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
    async (code: string) => {
      setError(null);
      setChatMessages([]);
      setTransfers([]);
      setMonitors([]);
      setActiveMonitorId(null);
      const session = new ViewerSession({
        code,
        signalingUrl: defaultSignalingUrl(),
        handlers: {
          onState: (st, detail) => {
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
  }, [recorder]);

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
    // Adjusting volume above zero implies the user wants to hear audio.
    if (v > 0) setMuted(false);
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
        {statsVisible && <StatsPanel stats={stats} decision={decision} />}
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
