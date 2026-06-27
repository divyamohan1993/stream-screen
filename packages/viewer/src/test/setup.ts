/**
 * Vitest jsdom setup. jsdom lacks a few DOM APIs the viewer touches; stub the
 * minimum so component code can run without throwing under test.
 */

// jsdom doesn't implement HTMLMediaElement.play; make it a resolved no-op.
if (typeof HTMLMediaElement !== 'undefined' && !HTMLMediaElement.prototype.play) {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
}
