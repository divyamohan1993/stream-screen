/**
 * StreamScreen LAN discovery over mDNS / DNS-SD (Bonjour / Avahi).
 *
 * A host advertises a `_streamscreen._tcp` service carrying its display name,
 * the signaling port, and (optionally) the session code in TXT records. Any
 * machine on the same LAN can browse for these and present a one-tap list of
 * nearby hosts — zero configuration, no cloud, no accounts.
 *
 * mDNS is best-effort: on locked-down networks or sandboxes the underlying
 * UDP multicast sockets may be unavailable. Every operation here is therefore
 * GUARDED so a missing/blocked mDNS stack degrades to a graceful no-op instead
 * of crashing the signaling server. Discovery is a convenience; manual
 * code-entry always works without it.
 */

import { Bonjour, type Service } from 'bonjour-service';
import type { SessionInfo } from '@stream-screen/core';

export const SERVICE_TYPE = 'streamscreen';
export const SERVICE_PROTOCOL = 'tcp' as const;

export interface AdvertiseOptions {
  /** Human-readable host name shown to viewers. */
  hostName: string;
  /** TCP port the signaling server listens on. */
  port: number;
  /** Optional active session code to publish in TXT records. */
  code?: string;
}

/** A host discovered on the LAN, plus the address/port needed to reach it. */
export interface DiscoveredHost extends SessionInfo {
  address?: string;
  port: number;
}

export interface BrowseOptions {
  /** How long to listen for responses before resolving, in ms. */
  timeoutMs?: number;
}

/**
 * Discovery façade. Lazily constructs the Bonjour instance and swallows any
 * construction error (e.g. multicast blocked) into `available = false`, so the
 * rest of the server can call advertise/browse unconditionally.
 */
export class Discovery {
  private bonjour: Bonjour | undefined;
  private service: Service | undefined;
  private failed = false;

  /** Whether the mDNS stack initialised successfully. */
  get available(): boolean {
    return !this.failed && this.bonjour !== undefined;
  }

  private ensure(): Bonjour | undefined {
    if (this.failed) return undefined;
    if (this.bonjour) return this.bonjour;
    try {
      this.bonjour = new Bonjour();
      return this.bonjour;
    } catch {
      this.failed = true;
      return undefined;
    }
  }

  /**
   * Advertise this host on the LAN. Replaces any previous advertisement.
   * Returns true if the service was published, false if mDNS is unavailable.
   */
  advertise(opts: AdvertiseOptions): boolean {
    const bonjour = this.ensure();
    if (!bonjour) return false;
    try {
      this.unadvertise();
      const txt: Record<string, string> = { host: opts.hostName };
      if (opts.code) txt.code = opts.code;
      this.service = bonjour.publish({
        name: `StreamScreen @ ${opts.hostName}`,
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port: opts.port,
        txt,
      });
      // A publish error must not take down the process.
      this.service.on('error', () => {
        /* best-effort advertisement */
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Stop advertising (idempotent, guarded). */
  unadvertise(): void {
    if (!this.service) return;
    try {
      this.service.stop?.();
    } catch {
      /* ignore */
    }
    this.service = undefined;
  }

  /**
   * Browse the LAN for StreamScreen hosts for `timeoutMs`, then resolve the
   * collected list. Always resolves (never rejects); returns [] when mDNS is
   * unavailable so callers can treat "no discovery" and "no hosts" uniformly.
   */
  async browse(opts: BrowseOptions = {}): Promise<DiscoveredHost[]> {
    const bonjour = this.ensure();
    if (!bonjour) return [];
    const timeoutMs = opts.timeoutMs ?? 1500;

    return new Promise<DiscoveredHost[]>((resolve) => {
      const found = new Map<string, DiscoveredHost>();
      let browser: ReturnType<Bonjour['find']> | undefined;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          browser?.stop();
        } catch {
          /* ignore */
        }
        resolve([...found.values()]);
      };

      try {
        browser = bonjour.find(
          { type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL },
          (service: Service) => {
            const host = serviceToHost(service);
            if (host) found.set(`${host.address ?? ''}:${host.port}:${host.code}`, host);
          },
        );
        // `error` isn't in Browser's typed event map; attach defensively.
        (browser as unknown as { on(ev: string, cb: () => void): void }).on('error', finish);
      } catch {
        resolve([]);
        return;
      }

      const t = setTimeout(finish, timeoutMs);
      t.unref?.();
    });
  }

  /** Tear down all mDNS resources (guarded, idempotent). */
  destroy(): void {
    this.unadvertise();
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        /* ignore */
      }
      this.bonjour = undefined;
    }
  }
}

/** Map a discovered Bonjour service to a {@link DiscoveredHost}. */
export function serviceToHost(service: Service): DiscoveredHost | undefined {
  if (!service || typeof service.port !== 'number') return undefined;
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const hostName =
    typeof txt.host === 'string' && txt.host ? txt.host : service.name || 'host';
  const code = typeof txt.code === 'string' ? txt.code : '';
  const address = pickAddress(service.addresses);
  return {
    code,
    hostName,
    createdAt: service.lastSeen ?? Date.now(),
    viewers: 0,
    address,
    port: service.port,
  };
}

/** Prefer an IPv4 address; fall back to the first available. */
function pickAddress(addresses?: string[]): string | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return ipv4 ?? addresses[0];
}
