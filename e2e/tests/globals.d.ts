import type { AdaptiveStats, InputEvent } from '@stream-screen/core';

/** Test hooks exposed by the fixture pages onto `window`. */
declare global {
  interface HostState {
    ready: boolean;
    connectionState: string;
    dataChannelOpen: boolean;
    receivedInputs: InputEvent[];
    lastInput: InputEvent | null;
    adaptiveDecisions: unknown[];
  }
  interface ViewerState {
    ready: boolean;
    connectionState: string;
    gotTrack: boolean;
    dataChannelOpen: boolean;
  }
  interface Window {
    __host: {
      getFrame(): number;
      getState(): HostState;
      getReceivedInputs(): InputEvent[];
      getLastInput(): InputEvent | null;
    };
    __viewer: {
      getState(): ViewerState;
      getVideoSize(): { width: number; height: number };
      isVideoPlaying(): boolean;
      getStats(): Promise<AdaptiveStats | { error: string }>;
      sendInput(ev: InputEvent): void;
    };
    __hostError?: string;
    __viewerError?: string;
  }
}

export {};
