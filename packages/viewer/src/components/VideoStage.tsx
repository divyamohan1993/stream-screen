import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { InputCapture } from '../input-capture.js';
import type { InputEvent } from '@stream-screen/core';

/** Imperative handle exposed by {@link VideoStage}. */
export interface VideoStageHandle {
  requestFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
  requestPointerLock: () => void;
  exitPointerLock: () => void;
  /** The underlying capture instance (e.g. for clipboard sync). */
  capture: InputCapture | null;
}

/** Props for {@link VideoStage}. */
export interface VideoStageProps {
  /** The remote screen stream to render (or null while waiting). */
  stream: MediaStream | null;
  /** Sink for captured input events (wired to the session). */
  onInput: (e: InputEvent) => void;
  /** Whether the stage is connected (controls the placeholder overlay). */
  connected: boolean;
  /** Overlay content rendered above the video (e.g. the stats panel). */
  children?: React.ReactNode;
}

/**
 * Renders the remote screen and captures all mouse/keyboard interaction over
 * it via {@link InputCapture}, forwarding resolution-independent
 * {@link InputEvent}s to the session. Exposes fullscreen / pointer-lock control
 * through an imperative handle so the toolbar can drive it.
 */
export const VideoStage = forwardRef<VideoStageHandle, VideoStageProps>(function VideoStage(
  { stream, onInput, connected, children },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureRef = useRef<InputCapture | null>(null);

  // Bind the stream to the <video>.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);

  // Set up input capture once the element exists.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const capture = new InputCapture({ video: v, send: onInput });
    captureRef.current = capture;
    capture.attach();
    return () => {
      capture.detach();
      captureRef.current = null;
    };
  }, [onInput]);

  useImperativeHandle(
    ref,
    () => ({
      requestFullscreen: () => captureRef.current?.requestFullscreen() ?? Promise.resolve(),
      exitFullscreen: () => captureRef.current?.exitFullscreen() ?? Promise.resolve(),
      requestPointerLock: () => captureRef.current?.requestPointerLock(),
      exitPointerLock: () => captureRef.current?.exitPointerLock(),
      get capture() {
        return captureRef.current;
      },
    }),
    [],
  );

  return (
    <div className="stage-wrap">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} className="stage-video" autoPlay playsInline muted tabIndex={0} />
      {!stream && (
        <div className="stage-overlay">
          {connected ? 'Connected — waiting for the host screen…' : 'Waiting for host…'}
        </div>
      )}
      {children}
    </div>
  );
});
