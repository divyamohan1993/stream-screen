/**
 * capture — screen enumeration and capture for the host RENDERER process.
 *
 * Electron exposes screen/window sources through `desktopCapturer` (main
 * process) and lets the renderer turn a source id into a live `MediaStream`
 * via `getUserMedia` with the non-standard `chromeMediaSource: 'desktop'`
 * constraints. This module owns the renderer half of that flow.
 *
 * The captured stream is fed straight into the core {@link Peer} — there are no
 * resolution or bitrate caps imposed here; we request up to the native screen
 * resolution at a 60fps target and let the adaptive engine scale down only as
 * the link demands.
 */

/** A capturable display/window source surfaced to the renderer. */
export interface CaptureSource {
  id: string;
  name: string;
  /** Whether this source is a whole screen (vs. an individual window). */
  isScreen: boolean;
}

/** Constraints describing the desired capture quality. */
export interface CaptureConstraints {
  /** Max width in pixels; defaults to native (no cap). */
  maxWidth?: number;
  /** Max height in pixels; defaults to native (no cap). */
  maxHeight?: number;
  /** Target frame rate; defaults to 60. */
  maxFrameRate?: number;
  /**
   * Whether the host cursor is baked into the captured frames. Defaults to
   * `false`: the viewer renders a low-latency LOCAL cursor on top of the stream
   * (see the viewer's cursor overlay), so baking the cursor in would show a
   * second, full-pipeline-latency cursor that visibly trails the local one. Set
   * `true` only if the viewer-side overlay is disabled.
   */
  cursor?: boolean;
}

/**
 * The non-standard `chromeMediaSource` desktop audio constraints. On Windows,
 * Chromium/Electron can capture system (loopback) audio in the same
 * `getUserMedia` call as the desktop video, by requesting
 * `audio.mandatory.chromeMediaSource = 'desktop'`. The audio loopback is NOT
 * tied to a specific source id — Windows mixes the whole desktop output.
 */
export interface DesktopAudioConstraints {
  mandatory: {
    chromeMediaSource: 'desktop';
  };
}

/**
 * The shape of the `chromeMediaSource` constraints object we hand to
 * `getUserMedia`. Typed explicitly because these fields are non-standard and
 * not present in lib.dom's `MediaTrackConstraints`. `audio` is either `false`
 * (no loopback) or the desktop loopback constraints object.
 */
export interface DesktopMediaConstraints {
  audio: false | DesktopAudioConstraints;
  video: {
    mandatory: {
      chromeMediaSource: 'desktop';
      chromeMediaSourceId: string;
      maxWidth?: number;
      maxHeight?: number;
      maxFrameRate?: number;
    };
    /**
     * Whether the OS cursor is composited into the captured frames. Made
     * EXPLICIT (rather than left to Chromium defaults) so the in-frame cursor can
     * be suppressed while the viewer renders an instant, client-side local
     * cursor on top of the stream.
     */
    cursor?: 'always' | 'never';
  };
}

/**
 * Build the `getUserMedia` constraints for a desktop source. Pure and
 * unit-testable; it performs no capture itself.
 *
 * When `withAudio` is true, the constraints additionally request the Windows
 * desktop loopback (system) audio track alongside the video. The two are merged
 * into a single gUM call, which is the only way Chromium grants desktop audio.
 *
 * Cursor compositing is set EXPLICITLY (defaulting to `'never'`) so we don't
 * inherit a Chromium default: the viewer renders a low-latency local cursor on
 * top of the stream, so baking the cursor into the frames would produce a second
 * cursor lagging a full round-trip behind. Pass `constraints.cursor = true` to
 * re-enable the in-frame cursor.
 */
export function buildDesktopConstraints(
  sourceId: string,
  constraints: CaptureConstraints = {},
  withAudio = false,
): DesktopMediaConstraints {
  const mandatory: DesktopMediaConstraints['video']['mandatory'] = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxFrameRate: constraints.maxFrameRate ?? 60,
  };
  if (constraints.maxWidth !== undefined) mandatory.maxWidth = constraints.maxWidth;
  if (constraints.maxHeight !== undefined) mandatory.maxHeight = constraints.maxHeight;
  const audio: DesktopMediaConstraints['audio'] = withAudio
    ? { mandatory: { chromeMediaSource: 'desktop' } }
    : false;
  const cursor: 'always' | 'never' = constraints.cursor ? 'always' : 'never';
  return { audio, video: { mandatory, cursor } };
}

/**
 * Acquire a {@link MediaStream} for the given desktop source id.
 *
 * Runs in the renderer; relies on `navigator.mediaDevices.getUserMedia`. The
 * non-standard desktop constraints are cast through `unknown` because they are
 * intentionally outside the standard `MediaStreamConstraints` shape.
 *
 * When `withAudio` is requested but the platform rejects the combined
 * audio+video desktop capture (common on non-Windows, or when no loopback
 * device exists), we transparently fall back to a video-only capture so the
 * session still starts. Callers can detect the result via the returned stream's
 * audio tracks (or {@link streamHasAudio}).
 */
export async function getDisplayStream(
  sourceId: string,
  constraints: CaptureConstraints = {},
  withAudio = false,
): Promise<MediaStream> {
  if (withAudio) {
    try {
      const both = buildDesktopConstraints(sourceId, constraints, true);
      return await navigator.mediaDevices.getUserMedia(
        both as unknown as MediaStreamConstraints,
      );
    } catch {
      // Loopback audio capture failed (unsupported platform / no device).
      // Fall through to a graceful video-only capture below.
    }
  }
  const desktop = buildDesktopConstraints(sourceId, constraints, false);
  return navigator.mediaDevices.getUserMedia(desktop as unknown as MediaStreamConstraints);
}

/** Whether a stream carries at least one (live) audio track. */
export function streamHasAudio(stream: MediaStream): boolean {
  return stream.getAudioTracks().length > 0;
}

/**
 * Normalize raw `desktopCapturer` sources (which we receive over IPC from the
 * main process) into {@link CaptureSource}. A source is treated as a full
 * screen when its display_id is set or its id begins with `screen:`.
 */
export function normalizeSources(
  raw: Array<{ id: string; name: string; display_id?: string }>,
): CaptureSource[] {
  return raw.map((s) => ({
    id: s.id,
    name: s.name,
    isScreen: Boolean(s.display_id) || s.id.startsWith('screen:'),
  }));
}

/**
 * Choose a default source to share: prefer the first whole-screen source,
 * falling back to the first source of any kind. Returns `null` if none.
 */
export function pickDefaultSource(sources: CaptureSource[]): CaptureSource | null {
  return sources.find((s) => s.isScreen) ?? sources[0] ?? null;
}
