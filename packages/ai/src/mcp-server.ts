/**
 * StreamScreen MCP server (stdio transport).
 *
 * Exposes the AI control surface as Model Context Protocol tools so an agent can
 * drive a remote desktop end to end: list_hosts, connect, disconnect,
 * screenshot, ocr_screen, move_mouse, click, type_text, press_key, get_stats,
 * list_monitors, switch_monitor, send_chat, set_quality, send_keys, press_combo.
 *
 * Tool names + JSON Schemas come from the shared {@link TOOL_DEFINITIONS}
 * registry, so this server and the REST API never diverge. The actual work is
 * delegated to a {@link RemoteDesktopSession}, which connects as a viewer via the
 * `@stream-screen/core` {@link Peer}. A node WebRTC runtime is OPTIONAL; when it
 * is absent, the connect/capture/control tools return a clear
 * "requires native webrtc runtime" message while the server, its tool list, and
 * schemas stay fully valid.
 *
 * Always free, no time limits: nothing here counts usage or expires a session.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, getToolDefinition, type ToolName } from './tools.js';
import {
  RemoteDesktopSession,
  WebRtcUnavailableError,
  type SessionOptions,
} from './session.js';
import { OcrUnavailableError, ocrImage } from './ocr.js';

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  /** Pre-built session (tests inject one); otherwise constructed from `session`. */
  session?: RemoteDesktopSession;
  /** Options forwarded to a freshly-constructed {@link RemoteDesktopSession}. */
  sessionOptions?: SessionOptions;
}

/** The MCP `Tool[]` shape, derived verbatim from the shared registry. */
export function mcpToolList(): Tool[] {
  return TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as unknown as Tool['inputSchema'],
  }));
}

/** Build a text-only tool result. */
function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/** Build an error tool result (isError flag set). */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Read a required string argument or throw a descriptive error. */
function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`Missing or invalid string argument "${key}".`);
  return v;
}

/** Read a required number argument or throw a descriptive error. */
function reqNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Missing or invalid number argument "${key}".`);
  return n;
}

/**
 * Dispatch a single tool call against a session. Returns a {@link CallToolResult}
 * (errors are returned as `isError` results, not thrown, so the agent sees a
 * clear message). Exported for direct unit testing without a transport.
 */
export async function dispatchTool(
  session: RemoteDesktopSession,
  name: string,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const def = getToolDefinition(name);
  if (!def) return errorResult(`Unknown tool: ${name}`);
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    switch (name as ToolName) {
      case 'list_hosts': {
        const hosts = await session.listHosts();
        return text(JSON.stringify(hosts, null, 2));
      }
      case 'connect': {
        await session.connect(reqString(args, 'code'));
        return text(`Connected to host ${session.code}.`);
      }
      case 'disconnect': {
        session.disconnect();
        return text('Disconnected.');
      }
      case 'screenshot': {
        const frame = await session.screenshot();
        return {
          content: [
            { type: 'image', data: frame.data.toString('base64'), mimeType: frame.mimeType },
          ],
        };
      }
      case 'ocr_screen': {
        const frame = await session.screenshot();
        const recognized = await ocrImage(frame.data);
        return text(recognized);
      }
      case 'move_mouse': {
        session.moveMouse(reqNumber(args, 'x'), reqNumber(args, 'y'));
        return text('ok');
      }
      case 'click': {
        const button = args.button === undefined ? undefined : reqNumber(args, 'button');
        session.click(reqNumber(args, 'x'), reqNumber(args, 'y'), button);
        return text('ok');
      }
      case 'type_text': {
        session.typeText(reqString(args, 'text'));
        return text('ok');
      }
      case 'press_key': {
        const mods = args.mods === undefined ? undefined : reqNumber(args, 'mods');
        session.pressKey(reqString(args, 'key'), mods);
        return text('ok');
      }
      case 'get_stats': {
        const stats = await session.getStats();
        return text(JSON.stringify(stats, null, 2));
      }
      case 'list_monitors': {
        const monitors = await session.listMonitors();
        return text(JSON.stringify(monitors, null, 2));
      }
      case 'switch_monitor': {
        session.switchMonitor(reqString(args, 'id'));
        return text('ok');
      }
      case 'send_chat': {
        session.sendChat(reqString(args, 'text'));
        return text('ok');
      }
      case 'set_quality': {
        const preset = session.setQuality(reqString(args, 'preset'));
        return text(`quality set to ${preset}`);
      }
      case 'send_keys': {
        session.sendKeys(args.keys);
        return text('ok');
      }
      case 'press_combo': {
        session.pressCombo(reqString(args, 'combo'));
        return text('ok');
      }
      default:
        return errorResult(`Unhandled tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof WebRtcUnavailableError || err instanceof OcrUnavailableError) {
      return errorResult(err.message);
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Construct the MCP {@link Server} with the StreamScreen tool surface wired to a
 * {@link RemoteDesktopSession}. The returned object also exposes the session so
 * callers (and tests) can inspect or tear it down.
 */
export function createMcpServer(opts: McpServerOptions = {}): {
  server: Server;
  session: RemoteDesktopSession;
} {
  const session = opts.session ?? new RemoteDesktopSession(opts.sessionOptions);

  const server = new Server(
    { name: 'streamscreen-ai', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchTool(session, request.params.name, request.params.arguments),
  );

  return { server, session };
}

/**
 * Start the MCP server on stdio. Resolves once connected; the process then stays
 * alive serving requests. There is no time limit.
 */
export async function startMcpServer(opts: McpServerOptions = {}): Promise<{
  server: Server;
  session: RemoteDesktopSession;
}> {
  const built = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  return built;
}
