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

function isDiscoveredHost(v: unknown): v is DiscoveredHost {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.port === 'number';
}
