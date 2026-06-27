import { describe, expect, it } from 'vitest';
import type { AdaptiveStats, ControlMessage, InputEvent } from '@stream-screen/core';
import { createMcpServer, dispatchTool, mcpToolList } from '../src/mcp-server.js';
import {
  RemoteDesktopSession,
  WebRtcUnavailableError,
  type SessionPeer,
} from '../src/session.js';
import {
  TOOL_DEFINITIONS,
  clamp,
  clampCoord,
  clickEvents,
  comboEvents,
  getToolDefinition,
  moveMouseEvent,
  pressKeyEvents,
  sendKeysEvents,
  toMods,
  toMouseButton,
  toQualityPreset,
  typeTextEvents,
} from '../src/tools.js';

/** The exact tool set the AI layer must expose. */
const EXPECTED_TOOLS = [
  'list_hosts',
  'connect',
  'disconnect',
  'screenshot',
  'ocr_screen',
  'move_mouse',
  'click',
  'type_text',
  'press_key',
  'get_stats',
  'list_monitors',
  'switch_monitor',
  'send_chat',
  'set_quality',
  'send_keys',
  'press_combo',
] as const;

/**
 * A fake {@link SessionPeer} that records every input/control message it
 * receives, so tests can assert the session's dispatch path actually reaches the
 * peer (no WebRTC runtime required).
 */
class FakePeer implements SessionPeer {
  readonly inputs: InputEvent[] = [];
  readonly controls: ControlMessage[] = [];
  private controlCb: ((m: ControlMessage) => void) | null = null;
  sendInput(e: InputEvent): void {
    this.inputs.push(e);
  }
  sendControl(m: ControlMessage): void {
    this.controls.push(m);
  }
  onControl(cb: (m: ControlMessage) => void): void {
    this.controlCb = cb;
  }
  /** Simulate an inbound control message from the host. */
  emit(m: ControlMessage): void {
    this.controlCb?.(m);
  }
  async getStats(): Promise<AdaptiveStats> {
    return {} as AdaptiveStats;
  }
  close(): void {}
}

describe('tool registry', () => {
  it('registers exactly the expected tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('every tool has a valid JSON-Schema input schema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties).toBeTypeOf('object');
      expect(typeof t.inputSchema.additionalProperties).toBe('boolean');
      // required (if present) must reference declared properties.
      for (const req of t.inputSchema.required ?? []) {
        expect(Object.keys(t.inputSchema.properties)).toContain(req);
      }
      // every property has a concrete type; arrays declare their item type.
      for (const prop of Object.values(t.inputSchema.properties)) {
        expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(prop.type);
        if (prop.type === 'array') {
          expect(prop.items).toBeTypeOf('object');
          expect(['string', 'number', 'integer', 'boolean']).toContain(prop.items?.type);
        }
      }
      // each tool maps to a REST route.
      expect(['GET', 'POST']).toContain(t.rest.method);
      expect(t.rest.path.startsWith('/api/')).toBe(true);
    }
  });

  it('schemas with parameters declare their required fields', () => {
    expect(getToolDefinition('connect')?.inputSchema.required).toEqual(['code']);
    expect(getToolDefinition('move_mouse')?.inputSchema.required).toEqual(['x', 'y']);
    expect(getToolDefinition('click')?.inputSchema.required).toEqual(['x', 'y']);
    expect(getToolDefinition('type_text')?.inputSchema.required).toEqual(['text']);
    expect(getToolDefinition('press_key')?.inputSchema.required).toEqual(['key']);
  });
});

describe('mcpToolList', () => {
  it('mirrors the registry into MCP Tool shape', () => {
    const list = mcpToolList();
    expect(list.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of list) {
      expect(tool.inputSchema).toBeTypeOf('object');
      expect((tool.inputSchema as { type?: string }).type).toBe('object');
    }
  });
});

describe('createMcpServer', () => {
  it('constructs a server and a session without a native webrtc runtime', () => {
    const { server, session } = createMcpServer();
    expect(server).toBeTruthy();
    expect(session).toBeInstanceOf(RemoteDesktopSession);
    expect(session.connected).toBe(false);
  });
});

describe('pure helpers: coordinate clamping', () => {
  it('clamps scalars to a range, NaN -> low', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-3, 0, 1)).toBe(0);
    expect(clamp(7, 0, 1)).toBe(1);
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });

  it('clamps coordinates into [0,1] x [0,1]', () => {
    expect(clampCoord(0.25, 0.75)).toEqual({ x: 0.25, y: 0.75 });
    expect(clampCoord(-1, 2)).toEqual({ x: 0, y: 1 });
    expect(clampCoord(Number.NaN, 1.5)).toEqual({ x: 0, y: 1 });
  });
});

describe('pure helpers: argument coercion', () => {
  it('coerces mouse buttons (default left)', () => {
    expect(toMouseButton(0)).toBe(0);
    expect(toMouseButton(1)).toBe(1);
    expect(toMouseButton(2)).toBe(2);
    expect(toMouseButton(5)).toBe(0);
    expect(toMouseButton(undefined)).toBe(0);
    expect(toMouseButton('2')).toBe(0); // strings are not buttons
  });

  it('coerces modifier bitflags to non-negative integers', () => {
    expect(toMods(3)).toBe(3);
    expect(toMods(undefined)).toBe(0);
    expect(toMods(-4)).toBe(0);
    expect(toMods(2.9)).toBe(2);
    expect(toMods('4')).toBe(4);
  });
});

describe('pure helpers: tool -> InputEvent mapping', () => {
  it('move_mouse -> single clamped m-move', () => {
    expect(moveMouseEvent(0.3, 0.4)).toEqual({ t: 'm-move', x: 0.3, y: 0.4 });
    expect(moveMouseEvent(2, -1)).toEqual({ t: 'm-move', x: 1, y: 0 });
  });

  it('click -> m-down then m-up at the same clamped point', () => {
    const [down, up] = clickEvents(0.5, 0.5, 2);
    expect(down).toEqual({ t: 'm-down', x: 0.5, y: 0.5, button: 2 });
    expect(up).toEqual({ t: 'm-up', x: 0.5, y: 0.5, button: 2 });
  });

  it('click defaults to left button on bad input', () => {
    const [down, up] = clickEvents(5, 5, 'nope');
    expect(down).toEqual({ t: 'm-down', x: 1, y: 1, button: 0 });
    expect(up).toEqual({ t: 'm-up', x: 1, y: 1, button: 0 });
  });

  it('press_key -> k-down then k-up with modifiers', () => {
    const [down, up] = pressKeyEvents('Enter', 2);
    expect(down).toEqual({ t: 'k-down', code: 'Enter', key: 'Enter', mods: 2 });
    expect(up).toEqual({ t: 'k-up', code: 'Enter', key: 'Enter', mods: 2 });
  });

  it('type_text -> a single clipboard event carrying the string', () => {
    const events = typeTextEvents('hello world');
    expect(events).toEqual<InputEvent[]>([{ t: 'clipboard', text: 'hello world' }]);
  });
});

describe('pure helpers: quality preset validation', () => {
  it('accepts every valid preset verbatim', () => {
    for (const p of ['auto', 'high', 'balanced', 'low'] as const) {
      expect(toQualityPreset(p)).toBe(p);
    }
  });

  it('rejects unknown or non-string presets', () => {
    expect(() => toQualityPreset('ultra')).toThrow(/invalid quality preset/i);
    expect(() => toQualityPreset('')).toThrow(/invalid quality preset/i);
    expect(() => toQualityPreset(undefined)).toThrow(/invalid quality preset/i);
    expect(() => toQualityPreset(2)).toThrow(/invalid quality preset/i);
  });
});

describe('pure helpers: key combos', () => {
  it('send_keys -> down chord then reverse up via buildKeyCombo', () => {
    const events = sendKeysEvents(['ctrl', 'alt', 'delete']);
    expect(events.map((e) => e.t)).toEqual(['k-down', 'k-down', 'k-down', 'k-up', 'k-up', 'k-up']);
  });

  it('send_keys rejects empty or non-string input', () => {
    expect(() => sendKeysEvents([])).toThrow(/keys/i);
    expect(() => sendKeysEvents('ctrl')).toThrow(/keys/i);
    expect(() => sendKeysEvents([1, 2])).toThrow(/keys/i);
  });

  it('press_combo maps named combos to InputEvent sequences', () => {
    const cad = comboEvents('ctrl+alt+del');
    expect(cad.length).toBeGreaterThan(0);
    expect(cad.every((e) => e.t === 'k-down' || e.t === 'k-up')).toBe(true);
    // case-insensitive and returns a fresh array (mutation-safe).
    const a = comboEvents('ALT+TAB');
    const b = comboEvents('alt+tab');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(comboEvents('escape').length).toBeGreaterThan(0);
  });

  it('press_combo rejects unknown combo names', () => {
    expect(() => comboEvents('mash+everything')).toThrow(/unknown combo/i);
    expect(() => comboEvents(undefined)).toThrow(/unknown combo/i);
  });
});

describe('dispatchTool (no native webrtc)', () => {
  it('returns a clear error for unknown tools', async () => {
    const session = new RemoteDesktopSession();
    const res = await dispatchTool(session, 'does_not_exist', {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('Unknown tool');
  });

  it('connect returns a clear error result (no crash) when it cannot complete', async () => {
    // Point at an unreachable signaling server so connect never blocks on the
    // network: whether or not a native WebRTC lib is present, dispatch must
    // resolve to an isError result with a readable message rather than throwing.
    const session = new RemoteDesktopSession({
      signalingUrl: 'ws://127.0.0.1:1', // nothing listens here
    });
    const res = await dispatchTool(session, 'connect', { code: '123456' });
    expect(res.isError).toBe(true);
    const msg = (res.content[0] as { text: string }).text;
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('WebRtcUnavailableError maps to the "requires native webrtc runtime" message', () => {
    expect(new WebRtcUnavailableError().message).toMatch(/native WebRTC runtime/i);
  });

  it('control tools fail clearly before a connection exists', async () => {
    const session = new RemoteDesktopSession();
    const res = await dispatchTool(session, 'click', { x: 0.5, y: 0.5 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not connected/i);
  });

  it('disconnect is always safe', async () => {
    const session = new RemoteDesktopSession();
    const res = await dispatchTool(session, 'disconnect', {});
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe('Disconnected.');
  });

  it('new control tools fail clearly before a connection exists', async () => {
    const session = new RemoteDesktopSession();
    for (const [name, args] of [
      ['list_monitors', {}],
      ['switch_monitor', { id: 'm1' }],
      ['send_chat', { text: 'x' }],
      ['set_quality', { preset: 'high' }],
      ['send_keys', { keys: ['ctrl', 'c'] }],
      ['press_combo', { combo: 'ctrl+alt+del' }],
    ] as const) {
      const res = await dispatchTool(session, name, args);
      expect(res.isError, `${name} should error when not connected`).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/not connected/i);
    }
  });
});

describe('RemoteDesktopSession control with an injected runtime', () => {
  it('rejects invalid session codes without needing a runtime', async () => {
    const session = new RemoteDesktopSession({
      // Injected ctor so we never reach a native lib; code validation fires first.
      rtcPeerConnection: class {} as unknown as typeof RTCPeerConnection,
    });
    await expect(session.connect('12')).rejects.toThrow(/6.?9 digits/i);
  });

  it('sends mapped InputEvents through the peer once connected', () => {
    const peer = new FakePeer();
    const session = new RemoteDesktopSession();
    session.attachTestPeer(peer);
    expect(session.connected).toBe(true);

    session.moveMouse(0.1, 0.2);
    session.click(0.3, 0.4, 0);
    session.pressKey('a', 1);

    // The session's own dispatch path (connected guard + peer.sendInput) is
    // exercised: the mapped events actually reach the peer, in order.
    expect(peer.inputs.map((e) => e.t)).toEqual(['m-move', 'm-down', 'm-up', 'k-down', 'k-up']);
    expect(peer.inputs[0]).toEqual({ t: 'm-move', x: 0.1, y: 0.2 });
    expect(peer.inputs[3]).toEqual({ t: 'k-down', code: 'a', key: 'a', mods: 1 });
  });

  it('sends control messages (chat, quality, switch-monitor, combos) through the peer', () => {
    const peer = new FakePeer();
    const session = new RemoteDesktopSession();
    session.attachTestPeer(peer);

    session.sendChat('hello host');
    session.setQuality('high');
    session.switchMonitor('display-2');
    session.sendKeys(['meta', 'r']);
    session.pressCombo('ctrl+alt+del');

    const chat = peer.controls.find((m) => m.t === 'chat');
    expect(chat).toMatchObject({ t: 'chat', text: 'hello host' });
    expect((chat as { ts: number }).ts).toBeTypeOf('number');
    expect(peer.controls).toContainEqual({ t: 'quality', preset: 'high' });
    expect(peer.controls).toContainEqual({ t: 'switch-monitor', id: 'display-2' });
    // send_keys and press_combo flow over the INPUT channel, not control.
    expect(peer.inputs.some((e) => e.t === 'k-down')).toBe(true);
  });

  it('list_monitors sends request-monitors and resolves on the host reply', async () => {
    const peer = new FakePeer();
    const session = new RemoteDesktopSession();
    session.attachTestPeer(peer);

    const pending = session.listMonitors(1000);
    expect(peer.controls).toContainEqual({ t: 'request-monitors' });
    // Host answers asynchronously.
    peer.emit({
      t: 'monitors',
      list: [{ id: 'm1', name: 'Primary', primary: true, width: 1920, height: 1080 }],
    });
    const monitors = await pending;
    expect(monitors).toEqual([
      { id: 'm1', name: 'Primary', primary: true, width: 1920, height: 1080 },
    ]);
  });

  it('control tools dispatch end-to-end through dispatchTool with a peer present', async () => {
    const peer = new FakePeer();
    const session = new RemoteDesktopSession();
    session.attachTestPeer(peer);

    expect((await dispatchTool(session, 'send_chat', { text: 'hi' })).isError).toBeFalsy();
    const quality = await dispatchTool(session, 'set_quality', { preset: 'low' });
    expect(quality.isError).toBeFalsy();
    expect((quality.content[0] as { text: string }).text).toContain('low');
    expect((await dispatchTool(session, 'press_combo', { combo: 'win' })).isError).toBeFalsy();
    expect((await dispatchTool(session, 'send_keys', { keys: ['ctrl', 'c'] })).isError).toBeFalsy();
    expect((await dispatchTool(session, 'switch_monitor', { id: 'm2' })).isError).toBeFalsy();

    expect(peer.controls).toContainEqual({ t: 'quality', preset: 'low' });
    expect(peer.controls).toContainEqual({ t: 'switch-monitor', id: 'm2' });
    expect(peer.inputs.some((e) => e.t === 'k-down')).toBe(true);
  });

  it('set_quality rejects an invalid preset via dispatchTool', async () => {
    const peer = new FakePeer();
    const session = new RemoteDesktopSession();
    session.attachTestPeer(peer);
    const res = await dispatchTool(session, 'set_quality', { preset: 'ludicrous' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/invalid quality preset/i);
  });
});

describe('WebRtcUnavailableError', () => {
  it('has an actionable message', () => {
    const e = new WebRtcUnavailableError();
    expect(e.message).toMatch(/native WebRTC runtime/i);
    expect(e.message).toMatch(/@roamhq\/wrtc/);
  });
});
