/**
 * Minimal ambient type shim for the OPTIONAL native WebRTC library
 * `@roamhq/wrtc`.
 *
 * `@roamhq/wrtc` ships prebuilt native bindings that are not guaranteed to be
 * installable in every environment (and we develop on Linux / CI where they may
 * be absent). It is therefore kept as an `optionalDependencies` entry and loaded
 * via dynamic `import()` at runtime — a missing native lib must never break the
 * workspace build or tests.
 *
 * This shim only declares the tiny surface {@link RemoteDesktopSession} relies
 * on: a CommonJS-style default export carrying an `RTCPeerConnection`
 * constructor compatible with the DOM lib types.
 */
declare module '@roamhq/wrtc' {
  /** The native `RTCPeerConnection` constructor (DOM-compatible). */
  export const RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  export const RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  export const RTCIceCandidate: typeof globalThis.RTCIceCandidate;
  export const MediaStream: typeof globalThis.MediaStream;

  const wrtc: {
    RTCPeerConnection: typeof globalThis.RTCPeerConnection;
    RTCSessionDescription: typeof globalThis.RTCSessionDescription;
    RTCIceCandidate: typeof globalThis.RTCIceCandidate;
    MediaStream: typeof globalThis.MediaStream;
  };
  export default wrtc;
}
