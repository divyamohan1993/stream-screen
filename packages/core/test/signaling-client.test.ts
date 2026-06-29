import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalingClient } from '../src/signaling-client.js';
import type { SignalMessage } from '../src/protocol.js';

/**
 * Fake WebSocket that satisfies the MinimalWebSocket surface SignalingClient
 * relies on. Installed as the global `WebSocket` so frames travel the real
 * `onmessage` -> `dispatch` path used in production.
 */
class FakeWS {
  static last: FakeWS | null = null;
  readyState = 1; // OPEN
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    FakeWS.last = this;
    // Open on next microtask so connect()'s awaited promise resolves.
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({});
  }

  /** Simulate an inbound frame from the server. */
  receive(m: SignalMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const origWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS as unknown;
  FakeWS.last = null;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = origWebSocket;
});

function offer(sdp: string): SignalMessage {
  return { type: 'offer', sdp, ts: Date.now() } as SignalMessage;
}

describe('SignalingClient negotiation-frame buffering', () => {
  it('replays an offer received before on("offer") is registered, in order', async () => {
    const client = new SignalingClient('ws://test');
    await client.connect();
    const ws = FakeWS.last!;

    // Host offer races ahead of the viewer registering its peer handler.
    ws.receive(offer('first'));
    ws.receive(offer('second'));

    const got: string[] = [];
    client.on('offer', (m) => got.push(m.sdp ?? ''));

    expect(got).toEqual(['first', 'second']);
  });

  it('dispatches immediately when a handler already exists (no behavior change)', async () => {
    const client = new SignalingClient('ws://test');
    await client.connect();
    const ws = FakeWS.last!;

    const got: string[] = [];
    client.on('offer', (m) => got.push(m.sdp ?? ''));

    ws.receive(offer('live'));
    expect(got).toEqual(['live']);

    // Nothing was buffered: a second handler registered later gets nothing.
    const got2: string[] = [];
    client.on('offer', (m) => got2.push(m.sdp ?? ''));
    expect(got2).toEqual([]);
  });

  it('caps the buffer and drops the oldest beyond the cap', async () => {
    const client = new SignalingClient('ws://test');
    await client.connect();
    const ws = FakeWS.last!;

    // Send more than the cap (8) before any handler exists.
    for (let i = 0; i < 12; i++) ws.receive(offer(`o${i}`));

    const got: string[] = [];
    client.on('offer', (m) => got.push(m.sdp ?? ''));

    // Only the most recent 8 survive, in order: o4..o11.
    expect(got).toEqual(['o4', 'o5', 'o6', 'o7', 'o8', 'o9', 'o10', 'o11']);
  });

  it('does not buffer non-negotiation frame types', async () => {
    const client = new SignalingClient('ws://test');
    await client.connect();
    const ws = FakeWS.last!;

    ws.receive({ type: 'joined', ts: Date.now() } as SignalMessage);

    const got: SignalMessage[] = [];
    client.on('joined', (m) => got.push(m));
    expect(got).toEqual([]);
  });

  it('clears the buffer on close so stale offers are not replayed', async () => {
    const client = new SignalingClient('ws://test');
    await client.connect();
    const ws = FakeWS.last!;

    ws.receive(offer('stale'));
    client.close();

    const got: string[] = [];
    client.on('offer', (m) => got.push(m.sdp ?? ''));
    expect(got).toEqual([]);
  });
});
