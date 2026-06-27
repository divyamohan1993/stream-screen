import React, { useCallback, useEffect, useState } from 'react';
import { discoverHosts, type DiscoveredHost } from '../discovery-client.js';

/** Props for {@link DiscoveryList}. */
export interface DiscoveryListProps {
  /** Invoked when the user picks a discovered host (by its session code). */
  onPick: (host: DiscoveredHost) => void;
  /** Auto-refresh interval, ms. Defaults to 4000. */
  refreshMs?: number;
}

/**
 * Lists StreamScreen hosts found on the LAN via the signaling server's mDNS
 * `/api/discover`. Refreshes periodically and degrades silently to an empty
 * state (manual code entry remains available) when discovery is unavailable.
 */
export function DiscoveryList({ onPick, refreshMs = 4000 }: DiscoveryListProps): React.JSX.Element {
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const found = await discoverHosts(signal);
    if (!signal?.aborted) {
      setHosts(found);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    const id = setInterval(() => void refresh(ctrl.signal), refreshMs);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [refresh, refreshMs]);

  return (
    <div className="discovery">
      <h3>LAN hosts {loading ? '· scanning…' : `· ${hosts.length} found`}</h3>
      {hosts.length === 0 && !loading && (
        <p className="hint">No hosts discovered. Enter a code manually above.</p>
      )}
      {hosts.map((h) => (
        <div className="host-row" key={`${h.code}-${h.address ?? ''}-${h.port}`}>
          <div className="meta">
            <span className="name">{h.hostName || 'StreamScreen host'}</span>
            <span className="sub">
              code {h.code}
              {h.address ? ` · ${h.address}:${h.port}` : ` · :${h.port}`} · {h.viewers} viewer
              {h.viewers === 1 ? '' : 's'}
            </span>
          </div>
          <button type="button" onClick={() => onPick(h)}>
            Connect
          </button>
        </div>
      ))}
    </div>
  );
}
