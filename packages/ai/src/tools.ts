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

import type { InputEvent } from '@stream-screen/core';

/** A JSON-Schema object describing a tool's parameters. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A single JSON-Schema property (the subset we emit). */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: Array<string | number>;
  default?: string | number | boolean;
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
  | 'get_stats';

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
 * produces. A `clipboard` event carries the whole string (the host pastes it),
 * which is both faster and more reliable for arbitrary unicode than synthesizing
 * per-character key strokes.
 */
export function typeTextEvents(text: string): InputEvent[] {
  return [{ t: 'clipboard', text }];
}
