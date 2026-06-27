import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Recording lifecycle state surfaced by {@link useRecorder}.
 *  - `idle`        no recording in progress
 *  - `recording`   MediaRecorder is actively capturing the stream
 *  - `unsupported` MediaRecorder is unavailable in this environment
 */
export type RecorderState = 'idle' | 'recording' | 'unsupported';

/** Public surface of the {@link useRecorder} hook. */
export interface Recorder {
  state: RecorderState;
  /** Whether a recording is currently in progress. */
  recording: boolean;
  /** Begin recording the supplied (or hook-bound) stream. No-op if already recording. */
  start: (stream?: MediaStream | null) => void;
  /** Stop recording, assemble a Blob, and trigger a `.webm` download. */
  stop: () => void;
}

/** Resolve a MediaRecorder mime type the browser supports, best-effort. */
function pickMimeType(): string | undefined {
  const MR = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return undefined;
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const c of candidates) {
    if (MR.isTypeSupported(c)) return c;
  }
  return undefined;
}

/**
 * Trigger a browser download of `blob` as `filename`. Pure DOM; no-op when the
 * document is unavailable (tests can inject `download`).
 */
function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Options for {@link useRecorder} (mostly test seams). */
export interface UseRecorderOptions {
  /** The stream to record by default (App passes the remote stream). */
  stream?: MediaStream | null;
  /** Injectable downloader (defaults to a real browser download). */
  download?: (blob: Blob, filename: string) => void;
  /** Injectable filename factory (defaults to a timestamped `.webm`). */
  filename?: () => string;
}

function defaultFilename(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `streamscreen-${stamp}.webm`;
}

/**
 * React hook wrapping {@link MediaRecorder} to record the incoming remote
 * {@link MediaStream} to a downloadable `.webm`. Captures chunks via
 * `ondataavailable`, assembles them into a Blob on stop, and triggers a
 * download. Recording imposes no time limit — StreamScreen is always unlimited.
 */
export function useRecorder(opts: UseRecorderOptions = {}): Recorder {
  const { stream, download = downloadBlob, filename = defaultFilename } = opts;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [state, setState] = useState<RecorderState>(() =>
    typeof (globalThis as { MediaRecorder?: unknown }).MediaRecorder === 'function'
      ? 'idle'
      : 'unsupported',
  );

  const start = useCallback(
    (override?: MediaStream | null) => {
      const MR = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
      if (!MR) {
        setState('unsupported');
        return;
      }
      if (recorderRef.current) return; // already recording
      const target = override ?? stream;
      if (!target) return;

      const mimeType = pickMimeType();
      const recorder = mimeType ? new MR(target, { mimeType }) : new MR(target);
      chunksRef.current = [];
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'video/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        recorderRef.current = null;
        setState('idle');
        if (blob.size > 0) download(blob, filename());
      };
      recorderRef.current = recorder;
      recorder.start();
      setState('recording');
    },
    [stream, download, filename],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state !== 'inactive') recorder.stop();
    else {
      recorderRef.current = null;
      setState('idle');
    }
  }, []);

  // Tear down an in-flight recording if the component unmounts.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* best-effort cleanup */
        }
      }
      recorderRef.current = null;
    };
  }, []);

  return { state, recording: state === 'recording', start, stop };
}
