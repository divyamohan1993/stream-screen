import React, { useRef, useState } from 'react';
import { isValidSessionCode } from '@stream-screen/core';
import { DiscoveryList } from './DiscoveryList.js';
import {
  normalizeSignalingUrl,
  signalingUrlForHost,
  type DiscoveredHost,
} from '../discovery-client.js';

/** localStorage key under which the last-used signaling server value is kept. */
const SIGNALING_STORAGE_KEY = 'streamscreen.signalingServer';

/** Read the persisted signaling-server value, tolerating absent storage/SSR. */
function loadSignalingServer(): string {
  try {
    return globalThis.localStorage?.getItem(SIGNALING_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist (or clear) the signaling-server value, tolerating absent storage. */
function saveSignalingServer(value: string): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    if (value.trim()) store.setItem(SIGNALING_STORAGE_KEY, value.trim());
    else store.removeItem(SIGNALING_STORAGE_KEY);
  } catch {
    /* ignore persistence failures — convenience only */
  }
}

/** Props for {@link ConnectScreen}. */
export interface ConnectScreenProps {
  /**
   * Start a session for the given code. When the code was chosen from a
   * discovered LAN host, `signalingUrl` is the ws URL of THAT host's signaling
   * server (e.g. `ws://192.168.1.50:8787`); it is omitted for manual code entry,
   * where the viewer's default signaling URL should be used.
   */
  onConnect: (code: string, signalingUrl?: string) => void;
  /** A connection error to display, if any. */
  error?: string | null;
  /** Whether a connection attempt is in flight. */
  connecting?: boolean;
}

/**
 * The landing screen: enter a 6–9 digit session code or pick a discovered LAN
 * host. No accounts, no sign-in — the code is the only gate. Emphasizes the
 * always-free, unlimited-time nature of StreamScreen.
 */
export function ConnectScreen({
  onConnect,
  error,
  connecting,
}: ConnectScreenProps): React.JSX.Element {
  const [code, setCode] = useState('');
  // Optional signaling-server override for MANUAL code entry. Lets a viewer
  // served from a machine OTHER than the signaling host (the quickstart "other
  // machine" case — e.g. viewer on localhost:5173 while the host joined
  // ws://192.168.1.10:8787) target the correct server. Empty → App derives the
  // default. Seeded from (and persisted to) localStorage for convenience.
  const [signalingServer, setSignalingServer] = useState(loadSignalingServer);
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = isValidSessionCode(code);

  const submit = (): void => {
    if (!valid || connecting) return;
    // When the user supplied a signaling server, normalize it (host:port or full
    // ws/wss URL) and connect THERE; otherwise pass no override so App falls back
    // to the derived defaultSignalingUrl(). Persist the value either way.
    saveSignalingServer(signalingServer);
    const override = normalizeSignalingUrl(signalingServer);
    if (override) onConnect(code, override);
    else onConnect(code);
  };

  const pick = (host: DiscoveredHost): void => {
    // Defense-in-depth for the discovery-code issue: a discovered host may
    // advertise an empty/invalid code (mDNS race, host not yet ready). Never
    // auto-connect with a bad code — that just produces a confusing failure.
    // Instead prefill whatever was advertised and focus the field so the user can
    // type/confirm the real code. Only auto-connect when the code is genuinely
    // valid (6–9 digits).
    const advertised = (host.code ?? '').replace(/\D/g, '').slice(0, 9);
    setCode(advertised);
    if (isValidSessionCode(advertised)) {
      // Connect to the discovered host's OWN signaling server (its advertised
      // address:port), not the viewer's default localhost endpoint — otherwise a
      // host on another LAN machine is unreachable and join fails with
      // no-such-session. Falls back to undefined (→ default) if no address was
      // advertised.
      if (!connecting) onConnect(advertised, signalingUrlForHost(host) ?? undefined);
    } else {
      inputRef.current?.focus();
    }
  };

  return (
    <div className="connect">
      <h1>StreamScreen</h1>
      <p className="tagline">
        Peer-to-peer remote desktop over your own WiFi. <span className="free-badge">always free</span>{' '}
        — no accounts, no relay, no time limits, no bitrate caps.
      </p>

      <div className="connect-card">
        <input
          ref={inputRef}
          className="code-input"
          inputMode="numeric"
          autoComplete="off"
          placeholder="000000"
          maxLength={9}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 9))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          aria-label="Session code"
        />
        <button className="primary" type="button" disabled={!valid || connecting} onClick={submit}>
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
        {error ? <p className="error-text">{error}</p> : null}
        {!error && !valid && code.length > 0 ? (
          <p className="hint">Codes are 6 to 9 digits.</p>
        ) : null}

        <input
          className="signaling-input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Signaling server (optional)"
          value={signalingServer}
          onChange={(e) => setSignalingServer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          aria-label="Signaling server"
        />
        <p className="hint">
          Leave blank to use this page&apos;s server. To connect to a host on
          another machine, enter its address (e.g. <code>192.168.1.10:8787</code>{' '}
          or <code>ws://192.168.1.10:8787</code>).
        </p>
      </div>

      <DiscoveryList onPick={pick} />
    </div>
  );
}
