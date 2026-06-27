/**
 * Regression test (P2) — "Remove file-send control handlers after completion".
 *
 * BUG: HostSession.sendFile() registers a PER-TRANSFER control handler on the
 * Peer (to route the viewer's file-accept / file-reject / file-error reply to
 * the right sender) but NEVER removed it after sender.start() settled. The
 * handler's closure captures `sender`, and createSender retains the whole file's
 * framed chunks for its lifetime, so EVERY completed or aborted host->viewer
 * transfer kept its file bytes alive on the Peer's handler set until the session
 * stopped. Repeated large sends therefore grew renderer memory UNBOUNDED.
 *
 * FIX: capture the disposer returned by Peer.onControl and call it in a FINALLY
 * after sender.start() settles (success OR failure), and drop the sender
 * reference so its cached chunks become GC-eligible.
 *
 * This test mocks the Peer (recording every add/remove of a control handler and
 * exposing the live handler count) and createSender (a controllable sender whose
 * start() promise the test resolves or rejects). It asserts that after a send
 * COMPLETES and after a send ABORTS/REJECTS, the per-transfer handler is removed
 * (handler count returns to the post-start baseline) and the sender created for
 * that transfer is no longer reachable from the Peer's handler set.
 *
 * BEFORE the fix this test fails (handler count grows by one per send and the
 * sender stays referenced); AFTER the fix it passes. No Electron / native deps
 * are touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SenderSpy {
  id: string;
  acceptCalls: number;
  abortCalls: number;
  startCalls: number;
  resolveStart: () => void;
  rejectStart: (e: Error) => void;
}

// Every createSender() call records its returned spy here so the test can drive
// start() resolution/rejection deterministically.
const senderSpies: SenderSpy[] = [];

vi.mock('@stream-screen/core', () => {
  class FakeMediaStreamTrack {
    kind: string;
    readyState: 'live' | 'ended' = 'live';
    enabled = true;
    contentHint = '';
    stop(): void {
      this.readyState = 'ended';
    }
    constructor(kind: string) {
      this.kind = kind;
    }
  }

  class FakeMediaStream {
    private tracks: FakeMediaStreamTrack[];
    constructor(tracks: FakeMediaStreamTrack[] = []) {
      this.tracks = [...tracks];
    }
    getTracks(): FakeMediaStreamTrack[] {
      return [...this.tracks];
    }
    getVideoTracks(): FakeMediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'video');
    }
    getAudioTracks(): FakeMediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
  }

  type Ctl = (m: unknown, remoteId: string) => void;

  class FakePeer {
    // The set of currently-registered control handlers. The test inspects its
    // size and contents to prove the per-transfer handler is removed.
    controlHandlers = new Set<Ctl>();
    onControlAddCalls = 0;
    onControlRemoveCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(): void {}
    on(): void {}
    onFileChunk(): void {}
    /** Mirrors core Peer.onControl: registers and returns a disposer. */
    onControl(cb: Ctl): () => void {
      this.controlHandlers.add(cb);
      this.onControlAddCalls += 1;
      return () => {
        this.controlHandlers.delete(cb);
        this.onControlRemoveCalls += 1;
      };
    }
    attachStream(): void {}
    replaceVideoTrack(): void {}
    sendControl(): void {}
    sendFileChunk(): void {}
    drainFile(): void {}
    async getStats(): Promise<unknown> {
      return { rttMs: 0, lossPct: 0, jitterMs: 0, bitrateKbps: 0 };
    }
    async start(): Promise<void> {}
    close(): void {}
  }

  class FakeSignalingClient {
    private handlers = new Map<string, Set<(m: unknown) => void>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string) {}
    async connect(): Promise<void> {}
    on(type: string, cb: (m: unknown) => void): void {
      let set = this.handlers.get(type);
      if (!set) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(cb);
    }
    off(): void {}
    join(): void {
      // Acknowledge the host join synchronously so start() resolves.
      for (const cb of this.handlers.get('joined') ?? []) cb({ type: 'joined' });
    }
    close(): void {}
  }

  class FakeAdaptiveController {
    constructor(..._args: unknown[]) {}
    update(): unknown {
      return { quality: 'auto' };
    }
  }

  class FakeFileTransferManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    onChunk(): void {}
    onControl(): void {}
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createSender = vi.fn((opts: any) => {
    let resolveStart!: () => void;
    let rejectStart!: (e: Error) => void;
    const startPromise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const spy: SenderSpy = {
      id: opts.meta.id,
      acceptCalls: 0,
      abortCalls: 0,
      startCalls: 0,
      resolveStart,
      rejectStart,
    };
    senderSpies.push(spy);
    return {
      id: opts.meta.id,
      accept(): void {
        spy.acceptCalls += 1;
      },
      abort(): void {
        spy.abortCalls += 1;
      },
      start(): Promise<void> {
        spy.startCalls += 1;
        return startPromise;
      },
    };
  });

  return {
    AdaptiveController: FakeAdaptiveController,
    Peer: FakePeer,
    SignalingClient: FakeSignalingClient,
    FileTransferManager: FakeFileTransferManager,
    createSender,
    KEY_MODS: { shift: 1, ctrl: 2, alt: 4, meta: 8 },
    CTRL_ALT_DEL: [],
    __FakeMediaStream: FakeMediaStream,
    __FakeMediaStreamTrack: FakeMediaStreamTrack,
  };
});

import { HostSession } from '../src/host-session.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as core from '@stream-screen/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (tracks?: unknown[]): unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStreamTrack = (core as any).__FakeMediaStreamTrack as {
  new (kind: string): unknown;
};

interface FakePeerShape {
  controlHandlers: Set<(m: unknown, id: string) => void>;
  onControlAddCalls: number;
  onControlRemoveCalls: number;
}

function makeSession(): HostSession {
  const video = new FakeMediaStreamTrack('video');
  const stream = new FakeMediaStream([video]);
  return new HostSession({
    signalingUrl: 'ws://test',
    code: '123456',
    hostName: 'test-host',
    sourceId: 'screen:0',
    onInput: () => {},
    joinTimeoutMs: 100,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: (async () => stream) as any,
  });
}

/** Wait for the microtask queue to flush so settled promises run their finally. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('HostSession.sendFile removes the per-transfer control handler (P2 regression)', () => {
  beforeEach(() => {
    senderSpies.length = 0;
    vi.clearAllMocks();
  });

  it('removes the handler and drops the sender after a COMPLETED send', async () => {
    const session = makeSession();
    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape;
    const baseline = peer.controlHandlers.size;

    const data = new Uint8Array([1, 2, 3, 4]);
    const sendPromise = session.sendFile({ name: 'a.bin', data, mime: 'application/octet-stream' });

    // While the transfer is in flight, the per-transfer handler is registered.
    expect(peer.controlHandlers.size).toBe(baseline + 1);
    expect(senderSpies).toHaveLength(1);
    const spy = senderSpies[0];
    expect(spy.startCalls).toBe(1);

    // Complete the transfer.
    spy.resolveStart();
    await sendPromise;
    await flush();

    // Handler removed: count returns to baseline, the disposer ran exactly once,
    // and none of the remaining handlers can reach this transfer's sender.
    expect(peer.controlHandlers.size).toBe(baseline);
    expect(peer.onControlRemoveCalls).toBe(1);
    for (const h of peer.controlHandlers) {
      h({ t: 'file-accept', id: spy.id }, 'viewer-1');
    }
    expect(spy.acceptCalls).toBe(0);
  });

  it('removes the handler and drops the sender after an ABORTED/REJECTED send', async () => {
    const session = makeSession();
    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape;
    const baseline = peer.controlHandlers.size;

    const data = new Uint8Array([9, 9, 9]);
    const sendPromise = session.sendFile({ name: 'b.bin', data, mime: 'application/octet-stream' });
    expect(peer.controlHandlers.size).toBe(baseline + 1);

    const spy = senderSpies[0];
    spy.rejectStart(new Error('rejected by viewer'));
    await expect(sendPromise).rejects.toThrow(/rejected by viewer/);
    await flush();

    // Even on failure the handler must be removed (finally), back to baseline.
    expect(peer.controlHandlers.size).toBe(baseline);
    expect(peer.onControlRemoveCalls).toBe(1);
    for (const h of peer.controlHandlers) {
      h({ t: 'file-accept', id: spy.id }, 'viewer-1');
    }
    expect(spy.acceptCalls).toBe(0);
  });

  it('does not accumulate handlers across many sequential sends', async () => {
    const session = makeSession();
    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peer = (session as any).peer as FakePeerShape;
    const baseline = peer.controlHandlers.size;

    for (let i = 0; i < 5; i++) {
      const p = session.sendFile({
        name: `f${i}.bin`,
        data: new Uint8Array([i]),
        mime: 'application/octet-stream',
      });
      senderSpies[senderSpies.length - 1].resolveStart();
      await p;
      await flush();
      // After each completed send the handler set is back to baseline — no leak.
      expect(peer.controlHandlers.size).toBe(baseline);
    }

    expect(peer.onControlRemoveCalls).toBe(5);
  });
});
