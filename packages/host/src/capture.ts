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
}

/**
 * The shape of the `chromeMediaSource` constraints object we hand to
 * `getUserMedia`. Typed explicitly because these fields are non-standard and
 * not present in lib.dom's `MediaTrackConstraints`.
 */
export interface DesktopMediaConstraints {
  audio: false;
  video: {
    mandatory: {
      chromeMediaSource: 'desktop';
      chromeMediaSourceId: string;
      maxWidth?: number;
      maxHeight?: number;
      maxFrameRate?: number;
    };
  };
}

/**
 * Build the `getUserMedia` constraints for a desktop source. Pure and
 * unit-testable; it performs no capture itself.
 */
export function buildDesktopConstraints(
  sourceId: string,
  constraints: CaptureConstraints = {},
): DesktopMediaConstraints {
  const mandatory: DesktopMediaConstraints['video']['mandatory'] = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxFrameRate: constraints.maxFrameRate ?? 60,
  };
  if (constraints.maxWidth !== undefined) mandatory.maxWidth = constraints.maxWidth;
  if (constraints.maxHeight !== undefined) mandatory.maxHeight = constraints.maxHeight;
  return { audio: false, video: { mandatory } };
}

/**
 * Acquire a {@link MediaStream} for the given desktop source id.
 *
 * Runs in the renderer; relies on `navigator.mediaDevices.getUserMedia`. The
 * non-standard desktop constraints are cast through `unknown` because they are
 * intentionally outside the standard `MediaStreamConstraints` shape.
 */
export async function getDisplayStream(
  sourceId: string,
  constraints: CaptureConstraints = {},
): Promise<MediaStream> {
  const desktop = buildDesktopConstraints(sourceId, constraints);
  return navigator.mediaDevices.getUserMedia(desktop as unknown as MediaStreamConstraints);
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
