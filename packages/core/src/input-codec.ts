import type { InputEvent } from './protocol.js';

/**
 * Serialize an {@link InputEvent} to a compact wire string for the WebRTC
 * data channel.
 *
 * NOTE: stub — full implementation lands in the core implementation phase.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function encodeInput(e: InputEvent): string {
  void e;
  throw new Error('not-implemented');
}

/**
 * Parse a wire string produced by {@link encodeInput} back into an
 * {@link InputEvent}.
 *
 * NOTE: stub — full implementation lands in the core implementation phase.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function decodeInput(s: string): InputEvent {
  void s;
  throw new Error('not-implemented');
}
