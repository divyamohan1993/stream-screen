/**
 * Regression test for the Ctrl+Alt+Del SAS routing fix (P2).
 *
 * The viewer toolbar's SAS button and the AI `press_combo` emit the
 * Ctrl+Alt+Del chord over the ORDINARY input data channel as individual
 * InputEvents. Before this fix HostSession forwarded every one of those events
 * straight to `onInput` (→ the main process's per-event injector), so the
 * Delete-with-Ctrl+Alt key-down was replayed as a synthetic key press — which
 * the Windows Secure Attention Sequence (SAS) ignores on the secure desktop.
 * The genuine SAS path (injectCombo → SendSAS) lived behind a SEPARATE renderer
 * IPC call that remote peers never trigger, so the advertised remote SAS button
 * did nothing.
 *
 * The fix routes the chord (detected as a `Delete` k-down with both Ctrl+Alt
 * held) to `onCombo` (wired to the main process's combo/SAS injector) exactly
 * once and SUPPRESSES the synthetic per-key replay of that Delete event, while
 * leaving all other input flowing through `onInput`.
 *
 * Only Peer/Signaling are faked (no Electron, no native deps, no WebRTC); the
 * test captures the `peer.onInput` callback HostSession registers and feeds it
 * the real CTRL_ALT_DEL sequence from core, asserting:
 *   - onCombo fires exactly once with the canonical chord,
 *   - the Delete-with-Ctrl+Alt key-down is NOT delivered to onInput,
 *   - ordinary keys still go through onInput.
 *
 * Fails before the fix (the Delete k-down reaches onInput and onCombo never
 * fires) and passes after.
 */

import { describe, expect, it, vi } from 'vitest';

// Capture the input callback HostSession registers on the Peer so the test can
// drive inbound InputEvents deterministically.
let capturedOnInput: ((e: unknown, viewerId: string) => void) | null = null;

vi.mock('@stream-screen/core', async () => {
  const actual = await vi.importActual<typeof import('@stream-screen/core')>(
    '@stream-screen/core',
  );

  class FakePeer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    onInput(cb: (e: unknown, viewerId: string) => void): void {
      capturedOnInput = cb;
    }
    on(): void {}
    onFileChunk(): void {}
    onControl(): void {}
    async start(): Promise<void> {}
    attachStream(): void {}
    async replaceVideoTrack(): Promise<boolean> {
      return true;
    }
    sendControl(): void {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async getStats(): Promise<any> {
      return {
        rttMs: 20,
        lossPct: 0,
        jitterMs: 2,
        fps: 60,
        width: 1920,
        height: 1080,
        availableKbps: 0,
        outboundKbps: 0,
      };
    }
    async applyDecision(): Promise<void> {}
    close(): void {}
  }

  class FakeSignalingClient {
    private handlers = new Map<string, Set<(m: { type: string }) => void>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string) {}
    async connect(): Promise<void> {}
    on(type: string, cb: (m: { type: string }) => void): void {
      let set = this.handlers.get(type);
      if (!set) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(cb);
    }
    off(type: string, cb: (m: { type: string }) => void): void {
      this.handlers.get(type)?.delete(cb);
    }
    // start() now awaits the server's `joined` ack; reply synchronously so the
    // host join handshake completes and start() resolves.
    join(): void {
      for (const cb of this.handlers.get('joined') ?? []) cb({ type: 'joined' });
    }
    close(): void {}
  }

  class FakeFileTransferManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    onChunk(): void {}
    onControl(): void {}
  }

  class FakeMediaStream {
    getTracks(): unknown[] {
      return [];
    }
    getVideoTracks(): unknown[] {
      return [];
    }
    getAudioTracks(): unknown[] {
      return [];
    }
  }

  return {
    ...actual,
    Peer: FakePeer,
    SignalingClient: FakeSignalingClient,
    FileTransferManager: FakeFileTransferManager,
    createSender: vi.fn(),
    __FakeMediaStream: FakeMediaStream,
  };
});

import { HostSession, isCtrlAltDelKeyDown } from '../src/host-session.js';
import * as core from '@stream-screen/core';
import { CTRL_ALT_DEL, KEY_MODS } from '@stream-screen/core';
import type { InputEvent } from '@stream-screen/core';

const MOD_CTRL = KEY_MODS.ctrl;
const MOD_ALT = KEY_MODS.alt;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeMediaStream = (core as any).__FakeMediaStream as { new (): unknown };

async function startSessionWithSpies(): Promise<{
  onInput: ReturnType<typeof vi.fn>;
  onCombo: ReturnType<typeof vi.fn>;
  feed: (e: InputEvent) => void;
  stop: () => void;
}> {
  capturedOnInput = null;
  const onInput = vi.fn();
  const onCombo = vi.fn();
  const session = new HostSession({
    signalingUrl: 'ws://test',
    code: '123456',
    hostName: 'test-host',
    sourceId: 'screen:0',
    onInput,
    onCombo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acquireStream: async () => new FakeMediaStream() as any,
  });
  await session.start();
  if (!capturedOnInput) throw new Error('HostSession did not register peer.onInput');
  const cb = capturedOnInput;
  return {
    onInput,
    onCombo,
    feed: (e: InputEvent) => cb(e, 'viewer-1'),
    stop: () => session.stop(),
  };
}

describe('isCtrlAltDelKeyDown (pure chord detector)', () => {
  it('matches a Delete key-down with both Ctrl and Alt held', () => {
    expect(
      isCtrlAltDelKeyDown({ t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_CTRL | MOD_ALT }),
    ).toBe(true);
    // The canonical core chord contains exactly this key-down.
    expect(CTRL_ALT_DEL.some((e) => isCtrlAltDelKeyDown(e))).toBe(true);
  });

  it('requires BOTH Ctrl and Alt (Ctrl+Delete alone does not match)', () => {
    expect(
      isCtrlAltDelKeyDown({ t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_CTRL }),
    ).toBe(false);
    expect(
      isCtrlAltDelKeyDown({ t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_ALT }),
    ).toBe(false);
  });

  it('ignores key-ups and non-Delete keys', () => {
    expect(
      isCtrlAltDelKeyDown({ t: 'k-up', code: 'Delete', key: 'Delete', mods: MOD_CTRL | MOD_ALT }),
    ).toBe(false);
    expect(
      isCtrlAltDelKeyDown({ t: 'k-down', code: 'KeyA', key: 'a', mods: MOD_CTRL | MOD_ALT }),
    ).toBe(false);
    expect(isCtrlAltDelKeyDown({ t: 'm-move', x: 0.5, y: 0.5 })).toBe(false);
  });
});

describe('HostSession Ctrl+Alt+Del → SAS routing (P2 regression)', () => {
  it('routes the Ctrl+Alt+Del chord to the combo/SAS path exactly once and suppresses the synthetic Delete replay', async () => {
    const { onInput, onCombo, feed, stop } = await startSessionWithSpies();

    // Replay the chord exactly as it arrives over the input channel: the real
    // core sequence (Ctrl down, Alt down, Delete down, then the reverse k-ups),
    // each event individually forwarded to the captured input callback.
    for (const ev of CTRL_ALT_DEL) feed(ev);

    // The genuine SAS/combo path fired exactly once with the canonical chord.
    expect(onCombo).toHaveBeenCalledTimes(1);
    expect(onCombo).toHaveBeenCalledWith(CTRL_ALT_DEL, 'viewer-1');

    // The Delete-with-Ctrl+Alt key-down was NOT synthetically injected: no
    // onInput call carries a Delete k-down while both Ctrl and Alt are held.
    const synthDeleteChord = onInput.mock.calls.some(([e]: [InputEvent]) => {
      if (e.t !== 'k-down') return false;
      const mods = e.mods;
      const ctrlAlt = (mods & MOD_CTRL) !== 0 && (mods & MOD_ALT) !== 0;
      return e.code === 'Delete' && ctrlAlt;
    });
    expect(synthDeleteChord).toBe(false);

    stop();
  });

  it('still forwards ordinary keys and other combos through onInput (not the SAS path)', async () => {
    const { onInput, onCombo, feed, stop } = await startSessionWithSpies();

    const typeA: InputEvent[] = [
      { t: 'k-down', code: 'KeyA', key: 'a', mods: 0 },
      { t: 'k-up', code: 'KeyA', key: 'a', mods: 0 },
    ];
    // Ctrl+Delete alone (a common editor shortcut) must NOT be treated as SAS.
    const ctrlDelete: InputEvent[] = [
      { t: 'k-down', code: 'Delete', key: 'Delete', mods: MOD_CTRL },
      { t: 'k-up', code: 'Delete', key: 'Delete', mods: MOD_CTRL },
    ];
    // Alt+Tab is a normal chord that must keep flowing through onInput.
    const altTab: InputEvent[] = [
      { t: 'k-down', code: 'AltLeft', key: 'Alt', mods: MOD_ALT },
      { t: 'k-down', code: 'Tab', key: 'Tab', mods: MOD_ALT },
      { t: 'k-up', code: 'Tab', key: 'Tab', mods: MOD_ALT },
      { t: 'k-up', code: 'AltLeft', key: 'Alt', mods: MOD_ALT },
    ];

    for (const ev of [...typeA, ...ctrlDelete, ...altTab]) feed(ev);

    // None of these are Ctrl+Alt+Del, so the SAS/combo path never fired.
    expect(onCombo).not.toHaveBeenCalled();
    // Every event was forwarded to the ordinary injector.
    expect(onInput).toHaveBeenCalledTimes(typeA.length + ctrlDelete.length + altTab.length);

    stop();
  });

  it('falls back to onInput for the Delete event when no onCombo is wired (behavior unchanged)', async () => {
    capturedOnInput = null;
    const onInput = vi.fn();
    const session = new HostSession({
      signalingUrl: 'ws://test',
      code: '123456',
      hostName: 'test-host',
      sourceId: 'screen:0',
      onInput,
      // no onCombo provided
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      acquireStream: async () => new FakeMediaStream() as any,
    });
    await session.start();
    if (!capturedOnInput) throw new Error('HostSession did not register peer.onInput');

    for (const ev of CTRL_ALT_DEL) capturedOnInput(ev, 'viewer-1');

    // Without an onCombo seam, every event (including the Delete chord) flows to
    // onInput exactly as before — no events are silently dropped.
    expect(onInput).toHaveBeenCalledTimes(CTRL_ALT_DEL.length);

    session.stop();
  });
});
