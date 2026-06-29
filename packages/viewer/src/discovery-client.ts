import type { SessionInfo } from '@stream-screen/core';

/**
 * A host discovered on the LAN via the signaling server's `/api/discover`
 * (mDNS browse). Mirrors the signaling package's `DiscoveredHost` shape without
 * importing a node-only module into the browser bundle.
 */
export interface DiscoveredHost extends SessionInfo {
  address?: string;
  port: number;
}

/**
 * Fetch the list of LAN hosts the signaling server can see over mDNS.
 *
 * Hits the dev-proxied (or same-origin) `/api/discover` endpoint. Returns an
 * empty list on any failure so the UI degrades gracefully to manual code entry
 * — discovery is a convenience, never a requirement.
 */
export async function discoverHosts(signal?: AbortSignal): Promise<DiscoveredHost[]> {
  try {
    const res = await fetch('/api/discover', { signal });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isDiscoveredHost);
  } catch {
    return [];
  }
}

/** Mint a fresh session code from the signaling server (POST /api/code). */
export async function mintCode(): Promise<string | null> {
  try {
    const res = await fetch('/api/code', { method: 'POST' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string') {
      return (data as { code: string }).code;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the signaling WebSocket URL for a discovered host from its advertised
 * `address`/`port`. A host found via mDNS on ANOTHER LAN machine runs its own
 * signaling server at that address — connecting to the viewer's own
 * {@link defaultSignalingUrl} (localhost:8787) would hit the wrong server and
 * fail with `no-such-session`. Returns `null` when no usable address was
 * advertised, so the caller can fall back to the default.
 */
export function signalingUrlForHost(host: DiscoveredHost): string | null {
  const address = host.address?.trim();
  if (!address) return null;
  // Bracket IPv6 literals so the host:port URL is well-formed.
  const authority = address.includes(':') ? `[${address}]` : address;
  return `ws://${authority}:${host.port}`;
}

/**
 * Normalize a user-entered signaling server value into a WebSocket URL.
 *
 * Accepts either a full ws/wss URL (returned as-is after trimming) or a bare
 * `host` / `host:port` authority, which is promoted to `ws://host:port`
 * (defaulting to port 8787 when none is given). IPv6 literals may be supplied
 * bracketed (`[::1]:8787`) or bare (`::1`); a bare literal is bracketed here.
 *
 * Returns `null` for an empty/blank value so callers can fall back to the
 * derived default signaling URL.
 */
export function normalizeSignalingUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Already a ws/wss URL — accept verbatim.
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  // Bracketed IPv6 authority, optionally with :port.
  const bracketed = /^\[[^\]]+\](?::\d+)?$/.exec(trimmed);
  if (bracketed) {
    return /\]:\d+$/.test(trimmed) ? `ws://${trimmed}` : `ws://${trimmed}:8787`;
  }
  // Bare IPv6 literal (more than one colon and no brackets) → bracket it.
  if ((trimmed.match(/:/g)?.length ?? 0) > 1) {
    return `ws://[${trimmed}]:8787`;
  }
  // host or host:port.
  return /:\d+$/.test(trimmed) ? `ws://${trimmed}` : `ws://${trimmed}:8787`;
}

function isDiscoveredHost(v: unknown): v is DiscoveredHost {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.port === 'number';
}
