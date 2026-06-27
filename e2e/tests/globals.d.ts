import type { AdaptiveStats, InputEvent, ControlMessage, MonitorInfo } from '@stream-screen/core';

/** A chat control message as recorded by a fixture page. */
type ChatMsg = Extract<ControlMessage, { t: 'chat' }>;

/** A reassembled inbound file as recorded by the host page. */
interface ReceivedFile {
  id: string;
  name: string;
  size: number;
  length: number;
  checksum: number;
}

/** Test hooks exposed by the fixture pages onto `window`. */
declare global {
  interface HostState {
    ready: boolean;
    connectionState: string;
    dataChannelOpen: boolean;
    receivedInputs: InputEvent[];
    lastInput: InputEvent | null;
    adaptiveDecisions: unknown[];
    chats: ChatMsg[];
    activeMonitor: string;
    receivedFiles: ReceivedFile[];
  }
  interface ViewerState {
    ready: boolean;
    connectionState: string;
    gotTrack: boolean;
    gotAudioTrack: boolean;
    dataChannelOpen: boolean;
    chats: ChatMsg[];
    monitors: MonitorInfo[];
    monitorSwitched: string | null;
  }
  interface Window {
    __host: {
      getFrame(): number;
      getState(): HostState;
      getReceivedInputs(): InputEvent[];
      getLastInput(): InputEvent | null;
      getChats(): ChatMsg[];
      getActiveMonitor(): string;
      getReceivedFiles(): ReceivedFile[];
      sendChat(text: string): void;
      sendFileToViewer(
        id: string,
        name: string,
        mime: string,
        bytesArray: number[],
      ): Promise<boolean>;
    };
    __viewer: {
      getState(): ViewerState;
      getVideoSize(): { width: number; height: number };
      isVideoPlaying(): boolean;
      getDecodedFrameCount(): number;
      getAudioTrackInfo(): {
        count: number;
        readyState: string | null;
        enabled: boolean | null;
      };
      setMuted(m: boolean): void;
      getStats(): Promise<AdaptiveStats | { error: string }>;
      sendInput(ev: InputEvent): void;
      sendChat(text: string): void;
      getChats(): ChatMsg[];
      requestMonitors(): void;
      getMonitors(): MonitorInfo[];
      switchMonitor(id: string): void;
      getMonitorSwitched(): string | null;
      sendFile(
        id: string,
        name: string,
        mime: string,
        bytesArray: number[],
      ): Promise<boolean>;
      getReceivedFiles(): ReceivedFile[];
      getReceivedFile(id: string): ReceivedFile | null;
      startRecording(): boolean;
      stopRecording(): Promise<{
        bytes: number;
        chunks: number;
        head: number[];
      }>;
    };
    __hostError?: string;
    __viewerError?: string;
  }
}

export {};
