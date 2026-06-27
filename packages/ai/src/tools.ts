/**
 * Tool registry — the single source of truth for the StreamScreen AI control
 * surface. Both the MCP server ({@link mcp-server}) and the REST API
 * ({@link rest-api}) are generated from these definitions so the two transports
 * can never drift apart.
 *
 * Each tool carries:
 *  - a stable `name` (the MCP tool name and the REST route slug),
 *  - a human `description`,
 *  - a JSON-Schema `inputSchema` (MCP `tools/list` returns this verbatim), and
 *  - REST routing metadata (`method` + `path`).
 *
 * The pure helpers in this module (coordinate clamping, the tool→InputEvent
 * mapping, modifier parsing) carry no I/O and are unit-tested directly.
 */

import {
  buildKeyCombo,
  SPECIAL_KEYS,
  type InputEvent,
  type QualityPreset,
} from '@stream-screen/core';

/** A JSON-Schema object describing a tool's parameters. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A single JSON-Schema property (the subset we emit). */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: Array<string | number>;
  default?: string | number | boolean;
  /** For `type: 'array'`, the schema of each item. */
  items?: { type: 'string' | 'number' | 'integer' | 'boolean' };
}

/** HTTP method a REST route uses to mirror an MCP tool. */
export type RestMethod = 'GET' | 'POST';

/** Canonical names of every tool exposed by the AI layer. */
export type ToolName =
  | 'list_hosts'
  | 'connect'
  | 'disconnect'
  | 'screenshot'
  | 'ocr_screen'
  | 'move_mouse'
  | 'click'
  | 'type_text'
  | 'press_key'
  | 'get_stats'
  | 'list_monitors'
  | 'switch_monitor'
  | 'send_chat'
  | 'set_quality'
  | 'send_keys'
  | 'press_combo';

/** A fully-described tool, used to generate both MCP and REST surfaces. */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  /** REST route metadata mirroring this tool. */
  rest: { method: RestMethod; path: string };
}

/** Convenience: a plain object schema with no properties. */
function emptySchema(): JsonSchema {
  return { type: 'object', properties: {}, additionalProperties: false };
}

/**
 * The complete tool catalogue. Order is stable so `tools/list` output and the
 * REST route table are deterministic.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'list_hosts',
    description:
      'List StreamScreen host machines currently discoverable on the LAN (via the signaling server). Returns each host name and session code.',
    inputSchema: emptySchema(),
    rest: { method: 'GET', path: '/api/hosts' },
  },
  {
    name: 'connect',
    description:
      'Connect to a remote desktop host as a viewer using its 6–9 digit session code. Establishes the peer-to-peer WebRTC connection; required before any control or capture tool.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The 6–9 digit session code advertised by the host.',
        },
        signalingUrl: {
          type: 'string',
          description:
            "Optional signaling WebSocket URL of the host (e.g. 'ws://192.168.1.50:8787'). For a host found on another LAN machine via list_hosts, leave unset — the discovered endpoint is used automatically. Provide it only to override or to reach a host not surfaced by list_hosts.",
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/connect' },
  },
  {
    name: 'disconnect',
    description: 'Disconnect from the current remote desktop session and release the connection.',
    inputSchema: emptySchema(),
    rest: { method: 'POST', path: '/api/disconnect' },
  },
  {
    name: 'screenshot',
    description:
      'Capture the current remote screen frame and return it as a base64-encoded PNG image.',
    inputSchema: emptySchema(),
    rest: { method: 'GET', path: '/api/screenshot' },
  },
  {
    name: 'ocr_screen',
    description:
      'Run optical character recognition (OCR) over the current remote screen frame and return the recognized text.',
    inputSchema: emptySchema(),
    rest: { method: 'GET', path: '/api/ocr' },
  },
  {
    name: 'move_mouse',
    description:
      'Move the remote mouse cursor to a normalized position. x and y are fractions in [0,1] of the remote screen width/height (0,0 = top-left, 1,1 = bottom-right).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Normalized X in [0,1].' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Normalized Y in [0,1].' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/move' },
  },
  {
    name: 'click',
    description:
      'Click a mouse button at a normalized position (x,y in [0,1]). button: 0=left (default), 1=middle, 2=right. Sends a press immediately followed by a release.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Normalized X in [0,1].' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Normalized Y in [0,1].' },
        button: {
          type: 'integer',
          enum: [0, 1, 2],
          default: 0,
          description: '0=left, 1=middle, 2=right.',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/click' },
  },
  {
    name: 'type_text',
    description:
      'Type a string of text on the remote machine, character by character, as keyboard input.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/type' },
  },
  {
    name: 'press_key',
    description:
      "Press and release a single key on the remote machine. key is a KeyboardEvent code/name (e.g. 'Enter', 'Escape', 'a', 'ArrowLeft', 'F5'). mods is a bitflag set: 1=shift, 2=ctrl, 4=alt, 8=meta.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "Key code/name, e.g. 'Enter' or 'a'." },
        mods: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Modifier bitflags: 1=shift, 2=ctrl, 4=alt, 8=meta.',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/key' },
  },
  {
    name: 'get_stats',
    description:
      'Get live connection quality statistics for the active session (round-trip time, packet loss, jitter, available bitrate, frame rate, resolution).',
    inputSchema: emptySchema(),
    rest: { method: 'GET', path: '/api/stats' },
  },
  {
    name: 'list_monitors',
    description:
      'List the displays/monitors available on the remote host. Sends a request to the host and returns the reported MonitorInfo list (id, name, primary, width, height). Requires an active connection.',
    inputSchema: emptySchema(),
    rest: { method: 'GET', path: '/api/monitors' },
  },
  {
    name: 'switch_monitor',
    description:
      'Switch the active monitor being streamed from the host to the display with the given id (as returned by list_monitors). The host swaps the video track in place (no full renegotiation).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The monitor id to switch to (from list_monitors).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/monitor' },
  },
  {
    name: 'send_chat',
    description:
      'Send a text chat message to the host operator over the session control channel.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The chat message text to send.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/chat' },
  },
  {
    name: 'set_quality',
    description:
      "Set the streaming quality preset for the session. One of 'auto', 'high', 'balanced', or 'low'. 'auto' lets the adaptive controller pick.",
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['auto', 'high', 'balanced', 'low'],
          description: "Quality preset: 'auto'|'high'|'balanced'|'low'.",
        },
      },
      required: ['preset'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/quality' },
  },
  {
    name: 'send_keys',
    description:
      "Press an arbitrary modifier+key combo on the remote machine as a single chord. keys is an ordered list of logical names, e.g. ['ctrl','alt','delete'] or ['meta','r']. Modifiers (shift,ctrl,alt,meta) are held while the final key(s) are pressed, then all are released in reverse order.",
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: "Ordered key names, e.g. ['ctrl','alt','delete'].",
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/keys' },
  },
  {
    name: 'press_combo',
    description:
      "Press a well-known special key combo by name. One of: 'ctrl+alt+del', 'win', 'alt+tab', 'win+r', 'win+d', 'alt+f4', 'escape'. Convenience wrapper over send_keys for the common chords.",
    inputSchema: {
      type: 'object',
      properties: {
        combo: {
          type: 'string',
          enum: ['ctrl+alt+del', 'win', 'alt+tab', 'win+r', 'win+d', 'alt+f4', 'escape'],
          description: 'The named special combo to press.',
        },
      },
      required: ['combo'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/api/combo' },
  },
] as const;

/** Look up a tool definition by name (undefined if unknown). */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O) — unit-tested directly.
// ---------------------------------------------------------------------------

/** Clamp a number to the inclusive range [lo, hi]. NaN clamps to `lo`. */
export function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** A normalized 2-D coordinate, each axis clamped to [0,1]. */
export interface NormCoord {
  x: number;
  y: number;
}

/**
 * Clamp an (x,y) pair to the normalized screen space [0,1]×[0,1]. Coordinates
 * sent over the wire are always resolution-independent fractions, so this guards
 * against out-of-range or NaN input from a caller.
 */
export function clampCoord(x: number, y: number): NormCoord {
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

/** Mouse buttons as used by the {@link InputEvent} contract. */
export type MouseButton = 0 | 1 | 2;

/** Coerce an arbitrary value to a valid mouse button (defaults to 0=left). */
export function toMouseButton(v: unknown): MouseButton {
  return v === 1 || v === 2 ? v : 0;
}

/** Coerce an arbitrary value to a non-negative modifier bitflag integer. */
export function toMods(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Map a `move_mouse` invocation to the single {@link InputEvent} it produces.
 */
export function moveMouseEvent(x: number, y: number): InputEvent {
  const c = clampCoord(x, y);
  return { t: 'm-move', x: c.x, y: c.y };
}

/**
 * Map a `click` invocation to the ordered pair of {@link InputEvent}s it
 * produces: a button press immediately followed by a release at the same point.
 */
export function clickEvents(x: number, y: number, button: unknown): [InputEvent, InputEvent] {
  const c = clampCoord(x, y);
  const b = toMouseButton(button);
  return [
    { t: 'm-down', x: c.x, y: c.y, button: b },
    { t: 'm-up', x: c.x, y: c.y, button: b },
  ];
}

/**
 * Map a `press_key` invocation to the ordered pair of {@link InputEvent}s it
 * produces: a key-down followed by a key-up. `key` is used for both `code` and
 * `key` fields of the event (the host resolves the actual platform key).
 */
export function pressKeyEvents(key: string, mods: unknown): [InputEvent, InputEvent] {
  const m = toMods(mods);
  return [
    { t: 'k-down', code: key, key, mods: m },
    { t: 'k-up', code: key, key, mods: m },
  ];
}

/**
 * Map a `type_text` invocation to the sequence of {@link InputEvent}s it
 * produces. A `clipboard` event carries the whole string; the host writes it to
 * the system clipboard and then synthesizes Ctrl+V to paste it into the focused
 * field. This is both faster and more reliable for arbitrary unicode than
 * synthesizing per-character key strokes.
 */
export function typeTextEvents(text: string): InputEvent[] {
  return [{ t: 'clipboard', text }];
}

/** The valid {@link QualityPreset} values, in the order the schema enumerates them. */
export const QUALITY_PRESETS: readonly QualityPreset[] = ['auto', 'high', 'balanced', 'low'];

/**
 * Coerce/validate an arbitrary value to a {@link QualityPreset}. Throws a
 * descriptive error for anything outside the allowed set, so the AI layer never
 * forwards a garbage preset to the host.
 */
export function toQualityPreset(v: unknown): QualityPreset {
  if (typeof v === 'string' && (QUALITY_PRESETS as readonly string[]).includes(v)) {
    return v as QualityPreset;
  }
  throw new Error(
    `Invalid quality preset "${String(v)}": expected one of ${QUALITY_PRESETS.join(', ')}.`,
  );
}

/**
 * Map a `send_keys` invocation to the {@link InputEvent} sequence it produces.
 * Delegates to {@link buildKeyCombo}, which holds modifiers across the chord and
 * releases everything in reverse. Throws if `keys` is empty or non-string.
 */
export function sendKeysEvents(keys: unknown): InputEvent[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('Missing or empty "keys": expected a non-empty array of key names.');
  }
  if (!keys.every((k) => typeof k === 'string' && k.length > 0)) {
    throw new Error('Invalid "keys": every entry must be a non-empty string.');
  }
  return buildKeyCombo(keys as string[]);
}

/** Canonical names of the special combos {@link comboEvents} understands. */
export type ComboName =
  | 'ctrl+alt+del'
  | 'win'
  | 'alt+tab'
  | 'win+r'
  | 'win+d'
  | 'alt+f4'
  | 'escape';

/** Map a named special combo to the matching {@link SPECIAL_KEYS} entry. */
const COMBO_TO_SPECIAL: Record<ComboName, keyof typeof SPECIAL_KEYS> = {
  'ctrl+alt+del': 'CTRL_ALT_DEL',
  win: 'WIN',
  'alt+tab': 'ALT_TAB',
  'win+r': 'WIN_R',
  'win+d': 'WIN_D',
  'alt+f4': 'ALT_F4',
  escape: 'ESCAPE',
};

/**
 * Map a `press_combo` invocation to the {@link InputEvent} sequence for the named
 * special chord (Ctrl+Alt+Del, Win, Alt+Tab, …). Throws on an unknown combo
 * name. Returns a fresh array so callers cannot mutate the shared SPECIAL_KEYS.
 */
export function comboEvents(combo: unknown): InputEvent[] {
  const name = typeof combo === 'string' ? (combo.toLowerCase() as ComboName) : undefined;
  const key = name && COMBO_TO_SPECIAL[name];
  if (!key) {
    throw new Error(
      `Unknown combo "${String(combo)}": expected one of ${Object.keys(COMBO_TO_SPECIAL).join(', ')}.`,
    );
  }
  return [...SPECIAL_KEYS[key]];
}
