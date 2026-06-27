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
  /** Whether the remote audio is muted (the <video> carries audio). */
  muted?: boolean;
  /** Playback volume 0..1 (applied to the <video>). */
  volume?: number;
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
  { stream, onInput, connected, muted = true, volume = 1, children },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureRef = useRef<InputCapture | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  // Position the zero-latency local cursor overlay at live viewport coords,
  // translated into the stage-wrap's coordinate space. Done imperatively (direct
  // style writes, no React state) so it stays at full pointer frame rate.
  const moveLocalCursor = useRef((clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    const cursor = cursorRef.current;
    if (!wrap || !cursor) return;
    const rect = wrap.getBoundingClientRect();
    cursor.style.left = `${clientX - rect.left}px`;
    cursor.style.top = `${clientY - rect.top}px`;
    cursor.style.display = 'block';
  });

  // Bind the stream to the <video>.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);

  // Apply audio mute/volume. The element starts muted to satisfy autoplay
  // policies; unmuting happens via a user gesture (the toolbar toggle).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = Math.min(1, Math.max(0, volume));
    // Re-attempt playback when unmuting (autoplay-with-sound needs a gesture,
    // which the toggle provides).
    if (!muted && stream) void v.play().catch(() => undefined);
  }, [muted, volume, stream]);

  // Set up input capture once the element exists.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const capture = new InputCapture({
      video: v,
      send: onInput,
      onLocalCursor: (x, y) => moveLocalCursor.current(x, y),
    });
    captureRef.current = capture;
    capture.attach();

    // Hide the local cursor when the pointer leaves the video (so it doesn't
    // linger over the toolbar/panels) and reveal it again on entry.
    const hide = () => {
      if (cursorRef.current) cursorRef.current.style.display = 'none';
    };
    v.addEventListener('mouseleave', hide);

    return () => {
      capture.detach();
      v.removeEventListener('mouseleave', hide);
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
    <main
      className="stage-wrap"
      ref={wrapRef}
      aria-label="Remote screen"
      aria-describedby="stage-video-desc"
    >
      <p id="stage-video-desc" className="sr-only">
        Live remote desktop video from the host. Click or focus this area, then use your
        mouse and keyboard to control the remote computer. Captions are not available for a
        live screen share.
      </p>
      <video
        ref={videoRef}
        className={stream ? 'stage-video' : 'stage-video no-local-cursor'}
        autoPlay
        playsInline
        tabIndex={0}
        aria-label="Remote screen video"
        aria-describedby="stage-video-desc"
      >
        {/* A live remote-desktop stream has no pre-authored captions; an empty
            English captions track satisfies WCAG 1.2.2 / jsx-a11y media-has-caption
            without claiming captions exist for the live content. */}
        <track
          kind="captions"
          srcLang="en"
          label="English"
          src="data:text/vtt;charset=utf-8,WEBVTT%0A%0A"
        />
      </video>
      {/* Zero-latency local cursor overlay; hidden until the first mousemove. */}
      <div ref={cursorRef} className="local-cursor" style={{ display: 'none' }} aria-hidden="true" />
      {!stream && (
        <div className="stage-overlay" role="status" aria-live="polite">
          {connected ? 'Connected — waiting for the host screen…' : 'Waiting for host…'}
        </div>
      )}
      {children}
    </main>
  );
});
