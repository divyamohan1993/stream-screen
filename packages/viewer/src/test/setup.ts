/**
 * Vitest jsdom setup. jsdom lacks a few DOM APIs the viewer touches; stub the
 * minimum so component code can run without throwing under test.
 */

// jsdom ships an HTMLMediaElement.play that THROWS "Not implemented" (the method
// exists but is a stub), so a presence check (`!play`) never replaces it and any
// component that calls play() — VideoStage when a stream is attached — would throw
// and, worse, `void v.play().catch(...)` would blow up on the undefined return.
// Always override it with a resolved no-op so media-bearing components render.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
}
