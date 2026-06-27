import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlMessage, InputEvent, AdaptiveStats } from '@stream-screen/core';

/**
 * Feature tests for the viewer session's control-channel + file-transfer wiring.
 *
 * We mock core's `Peer`/`SignalingClient` so the session runs without real
 * WebRTC, capturing the handlers it registers and the messages/chunks it emits.
 * `createSender`/`FileTransferManager` remain the REAL core implementations so
 * the file offer/accept/stream state machine is exercised end to end.
 */

// A controllable fake Peer shared with the test body.
class FakePeer {
  static current: FakePeer | null = null;
  controlCb: ((m: ControlMessage) => void) | null = null;
  chunkCb: ((b: ArrayBuffer) => void) | null = null;
  inputCb: ((e: InputEvent) => void) | null = null;
  sentControl: ControlMessage[] = [];
  sentChunks: ArrayBuffer[] = [];
  sentInput: InputEvent[] = [];
  /** Stats returned by the next getStats() call (drives latency telemetry). */
  nextStats: AdaptiveStats = {
    rttMs: 42,
    lossPct: 0,
    jitterMs: 7,
    availableKbps: 5000,
    fps: 31,
    width: 1920,
    height: 1080,
    playoutMs: 18,
    ts: 0,
  };

  constructor() {
    FakePeer.current = this;
  }
  on(): void {}
  async start(): Promise<void> {}
  async getStats(): Promise<AdaptiveStats> {
    return { ...this.nextStats, ts: Date.now() };
  }
  sendControl(m: ControlMessage): void {
    this.sentControl.push(m);
  }
  onControl(cb: (m: ControlMessage) => void): void {
    this.controlCb = cb;
  }
  sendFileChunk(b: ArrayBuffer): void {
    this.sentChunks.push(b);
  }
  onFileChunk(cb: (b: ArrayBuffer) => void): void {
    this.chunkCb = cb;
  }
  getFileBufferedAmount(): number {
    return 0;
  }
  async drainFile(): Promise<void> {}
  sendInput(e: InputEvent): void {
    this.sentInput.push(e);
  }
  onInput(cb: (e: InputEvent) => void): void {
    this.inputCb = cb;
  }
  close(): void {}
}

class FakeSignaling {
  on(): void {}
  async connect(): Promise<void> {}
  join(): void {}
  close(): void {}
}

vi.mock('@stream-screen/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stream-screen/core')>();
  return {
    ...actual,
    Peer: FakePeer,
    SignalingClient: FakeSignaling,
  };
});

// Import AFTER the mock is registered.
const { ViewerSession } = await import('./viewer-session.js');
type Handlers = import('./viewer-session.js').ViewerSessionHandlers;

async function connectedSession(handlers: Handlers = {}) {
  const session = new ViewerSession({ code: '123456', signalingUrl: 'ws://x:8787', handlers });
  await session.connect();
  return session;
}

describe('ViewerSession control channel', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('sends and echoes chat messages', async () => {
    const received: { from: string; text: string }[] = [];
    const session = await connectedSession({ onChat: (e) => received.push(e) });
    session.sendChat('  hello host  ');
    const peer = FakePeer.current!;
    // Outbound control frame + local echo.
    const chat = peer.sentControl.find((m) => m.t === 'chat');
    expect(chat).toMatchObject({ t: 'chat', text: 'hello host' });
    expect(received).toEqual([{ from: 'me', text: 'hello host', ts: expect.any(Number) }]);
  });

  it('ignores blank chat', async () => {
    const session = await connectedSession();
    session.sendChat('   ');
    expect(FakePeer.current!.sentControl.find((m) => m.t === 'chat')).toBeUndefined();
  });

  it('surfaces inbound chat from the host', async () => {
    const received: { from: string; text: string }[] = [];
    await connectedSession({ onChat: (e) => received.push(e) });
    FakePeer.current!.controlCb!({ t: 'chat', text: 'hi viewer', ts: 5 });
    expect(received).toEqual([{ from: 'host', text: 'hi viewer', ts: 5 }]);
  });

  it('requests and reflects monitors + switch', async () => {
    const monitors: unknown[] = [];
    let switchedTo = '';
    const session = await connectedSession({
      onMonitors: (l) => monitors.push(...l),
      onMonitorSwitched: (id) => (switchedTo = id),
    });
    session.requestMonitors();
    expect(FakePeer.current!.sentControl).toContainEqual({ t: 'request-monitors' });

    FakePeer.current!.controlCb!({
      t: 'monitors',
      list: [{ id: 'm1', name: 'Display 1', primary: true, width: 1920, height: 1080 }],
    });
    expect(monitors).toHaveLength(1);

    session.switchMonitor('m2');
    expect(FakePeer.current!.sentControl).toContainEqual({ t: 'switch-monitor', id: 'm2' });

    FakePeer.current!.controlCb!({ t: 'monitor-switched', id: 'm2' });
    expect(switchedTo).toBe('m2');
  });

  it('toggles audio via a control message', async () => {
    const session = await connectedSession();
    session.setAudioEnabled(false);
    session.setAudioEnabled(true);
    const audio = FakePeer.current!.sentControl.filter((m) => m.t === 'audio');
    expect(audio).toEqual([
      { t: 'audio', enabled: false },
      { t: 'audio', enabled: true },
    ]);
  });

  it('sends the selected quality preset as a control frame (mapped to wire case)', async () => {
    const session = await connectedSession();
    session.setQuality('Low');
    session.setQuality('Auto');
    const quality = FakePeer.current!.sentControl.filter((m) => m.t === 'quality');
    expect(quality).toEqual([
      { t: 'quality', preset: 'low' },
      { t: 'quality', preset: 'auto' },
    ]);
  });

  it('maps every UI preset to its lowercase wire preset', async () => {
    const session = await connectedSession();
    session.setQuality('High');
    session.setQuality('Balanced');
    const quality = FakePeer.current!.sentControl.filter((m) => m.t === 'quality');
    expect(quality).toEqual([
      { t: 'quality', preset: 'high' },
      { t: 'quality', preset: 'balanced' },
    ]);
  });

  it('forwards a special-key input sequence', async () => {
    const session = await connectedSession();
    session.sendInputSequence([
      { t: 'k-down', code: 'ControlLeft', key: 'Control', mods: 2 },
      { t: 'k-up', code: 'ControlLeft', key: 'Control', mods: 0 },
    ]);
    expect(FakePeer.current!.sentInput).toHaveLength(2);
    expect(FakePeer.current!.sentInput[0].t).toBe('k-down');
  });
});

describe('ViewerSession real-time latency telemetry', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('reports measured interactive latency to the host on each stats poll', async () => {
    vi.useFakeTimers();
    try {
      const session = new ViewerSession({
        code: '123456',
        signalingUrl: 'ws://x:8787',
        statsIntervalMs: 1000,
      });
      await session.connect();
      const peer = FakePeer.current!;
      peer.nextStats = {
        rttMs: 55,
        lossPct: 1,
        jitterMs: 9,
        availableKbps: 6000,
        fps: 28,
        width: 1280,
        height: 720,
        playoutMs: 30,
        ts: 0,
      };

      // Drive one stats tick (the loop polls on the configured interval).
      await vi.advanceTimersByTimeAsync(1000);

      const latency = peer.sentControl.find((m) => m.t === 'latency');
      expect(latency).toEqual({ t: 'latency', rttMs: 55, playoutMs: 30, fps: 28 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports playoutMs as 0 when the stats snapshot omits it', async () => {
    vi.useFakeTimers();
    try {
      const session = new ViewerSession({
        code: '123456',
        signalingUrl: 'ws://x:8787',
        statsIntervalMs: 500,
      });
      await session.connect();
      const peer = FakePeer.current!;
      peer.nextStats = {
        rttMs: 12,
        lossPct: 0,
        jitterMs: 2,
        availableKbps: 8000,
        fps: 60,
        width: 1920,
        height: 1080,
        ts: 0,
      } as AdaptiveStats;
      delete (peer.nextStats as { playoutMs?: number }).playoutMs;

      await vi.advanceTimersByTimeAsync(500);

      const latency = peer.sentControl.find((m) => m.t === 'latency');
      expect(latency).toEqual({ t: 'latency', rttMs: 12, playoutMs: 0, fps: 60 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ViewerSession file transfer (send/offer state machine)', () => {
  beforeEach(() => {
    FakePeer.current = null;
  });

  it('emits an offer, waits for accept, then streams chunks and completes', async () => {
    const events: { status: string; progress: number }[] = [];
    const session = await connectedSession({
      onFileTransfer: (e) => events.push({ status: e.status, progress: e.progress }),
    });
    const peer = FakePeer.current!;

    const data = new Uint8Array(40000); // > 2 chunks at 16KiB
    data.fill(7);
    const id = session.sendFile({ name: 'a.bin', size: data.byteLength, type: 'application/octet-stream' }, data);

    // The offer goes out immediately; no chunks yet (awaiting accept).
    const offer = peer.sentControl.find((m) => m.t === 'file-offer');
    expect(offer).toMatchObject({ t: 'file-offer', name: 'a.bin', size: 40000, id });
    expect(peer.sentChunks.length).toBe(0);
    expect(events[0]).toMatchObject({ status: 'offered' });

    // Host accepts → sender releases the chunk stream.
    peer.controlCb!({ t: 'file-accept', id });
    // Let the async start() pump run.
    await new Promise((r) => setTimeout(r, 0));

    expect(peer.sentChunks.length).toBeGreaterThanOrEqual(3); // 40000/16384 -> 3 chunks
    const complete = peer.sentControl.find((m) => m.t === 'file-complete');
    expect(complete).toMatchObject({ t: 'file-complete', id });
    expect(events.some((e) => e.status === 'complete')).toBe(true);
  });

  it('aborts an outbound transfer on file-reject', async () => {
    const events: { status: string }[] = [];
    const session = await connectedSession({ onFileTransfer: (e) => events.push({ status: e.status }) });
    const peer = FakePeer.current!;
    const data = new Uint8Array(100);
    const id = session.sendFile({ name: 'b.bin', size: 100, type: '' }, data);

    peer.controlCb!({ t: 'file-reject', id });
    await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.status === 'rejected')).toBe(true);
    expect(peer.sentControl.find((m) => m.t === 'file-complete')).toBeUndefined();
  });

  it('reassembles an inbound file and reports it ready (auto-accept)', async () => {
    let ready: { name: string; bytes: number } | null = null;
    await connectedSession({
      onFileReady: (data, meta) => (ready = { name: meta.name, bytes: data.byteLength }),
    });
    const peer = FakePeer.current!;

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const meta = { id: 'in1', name: 'down.bin', size: payload.byteLength, mime: 'application/octet-stream' };

    // Host offers → manager auto-accepts (we should emit file-accept).
    peer.controlCb!({ t: 'file-offer', ...meta });
    expect(peer.sentControl).toContainEqual({ t: 'file-accept', id: 'in1' });

    // Build a framed chunk via the real core encoder and feed it as a binary chunk.
    const { frameChunk } = await import('@stream-screen/core');
    peer.chunkCb!(frameChunk('in1', 0, payload));
    peer.controlCb!({ t: 'file-complete', id: 'in1' });

    expect(ready).toEqual({ name: 'down.bin', bytes: 5 });
  });
});
