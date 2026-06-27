/**
 * @stream-screen/core — public surface.
 *
 * Re-exports the shared protocol contract and the runtime building blocks
 * (peer, signaling client, adaptive controller, input codec) that every other
 * package codes against.
 */

export * from './protocol.js';
export * from './peer.js';
export * from './signaling-client.js';
export * from './adaptive.js';
export * from './input-codec.js';
