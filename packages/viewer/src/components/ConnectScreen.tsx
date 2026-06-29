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
/** localStorage key under which the optional local ICE-servers override is kept. */
const ICE_SERVERS_STORAGE_KEY = 'streamscreen.iceServers';

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

/** Read the persisted ICE-servers override, tolerating absent storage/SSR. */
function loadIceServers(): string {
  try {
    return globalThis.localStorage?.getItem(ICE_SERVERS_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist (or clear) the ICE-servers override, tolerating absent storage. */
function saveIceServers(value: string): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    if (value.trim()) store.setItem(ICE_SERVERS_STORAGE_KEY, value.trim());
    else store.removeItem(ICE_SERVERS_STORAGE_KEY);
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
   *
   * `iceServers` is the optional, advanced LOCAL STUN/TURN override the operator
   * typed (compact `stun:host:port` / `turn:user:pass@host:port` tokens, or a
   * JSON array) — passed through raw so the caller parses it with core's
   * `parseIceServers`. Empty/omitted keeps the LAN-only default (the
   * server-distributed list from the `joined` ack is still used when present).
   */
  onConnect: (code: string, signalingUrl?: string, iceServers?: string) => void;
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
  // Optional, ADVANCED local STUN/TURN override for "connect from anywhere"
  // (NAT traversal across the internet). Empty by default → LAN-only behavior is
  // unchanged. When the operator self-hosts STUN/TURN, the signaling server can
  // distribute it to both peers automatically (the `joined` ack); this field is
  // a per-viewer override for the case where only this client knows the servers.
  // Seeded from (and persisted to) localStorage, like the signaling URL field.
  const [iceServers, setIceServers] = useState(loadIceServers);
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = isValidSessionCode(code);

  const submit = (): void => {
    if (!valid || connecting) return;
    // When the user supplied a signaling server, normalize it (host:port or full
    // ws/wss URL) and connect THERE; otherwise pass no override so App falls back
    // to the derived defaultSignalingUrl(). Persist both fields either way.
    saveSignalingServer(signalingServer);
    saveIceServers(iceServers);
    const override = normalizeSignalingUrl(signalingServer);
    emitConnect(code, override || undefined, iceServers.trim() || undefined);
  };

  // Invoke onConnect with the MINIMAL argument list: trailing absent args are
  // dropped so a plain manual connect stays `onConnect(code)` and a LAN pick
  // stays `onConnect(code, url)` — only the advanced ICE override (when set)
  // extends the call to the third argument.
  const emitConnect = (c: string, url?: string, ice?: string): void => {
    if (ice) onConnect(c, url, ice);
    else if (url) onConnect(c, url);
    else onConnect(c);
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
      // advertised. Carry through any advanced ICE override so a LAN pick can
      // still relay if the operator configured one (persist it too).
      saveIceServers(iceServers);
      // Preserve the original 2-arg pick call shape (signaling URL passed
      // positionally, possibly undefined); only EXTEND to a third arg when an
      // advanced ICE override is configured.
      const url = signalingUrlForHost(host) ?? undefined;
      const ice = iceServers.trim() || undefined;
      if (!connecting) {
        if (ice) onConnect(advertised, url, ice);
        else onConnect(advertised, url);
      }
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

      <div className="connect-card" role="region" aria-label="Join a session">
        <label className="field-label" htmlFor="session-code">
          Session code
        </label>
        <input
          ref={inputRef}
          id="session-code"
          name="session-code"
          className="code-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          placeholder="000000"
          maxLength={9}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 9))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          aria-label="Session code"
          aria-describedby="session-code-hint"
        />
        <button className="primary" type="button" disabled={!valid || connecting} onClick={submit}>
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        {!error && !valid && code.length > 0 ? (
          <p className="hint" id="session-code-hint" role="status">
            Codes are 6 to 9 digits.
          </p>
        ) : (
          <span id="session-code-hint" className="sr-only">
            Enter the 6 to 9 digit code shown on the host.
          </span>
        )}

        <label className="field-label" htmlFor="signaling-server">
          Signaling server (optional)
        </label>
        <input
          id="signaling-server"
          name="signaling-server"
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
          aria-describedby="signaling-server-hint"
        />
        <p className="hint" id="signaling-server-hint">
          Leave blank to use this page&apos;s server. To connect to a host on
          another machine, enter its address (e.g. <code>192.168.1.10:8787</code>{' '}
          or <code>ws://192.168.1.10:8787</code>).
        </p>

        <details className="advanced-ice">
          <summary>Connect from anywhere (advanced)</summary>
          <label className="field-label" htmlFor="ice-servers">
            ICE servers (STUN/TURN)
          </label>
          <input
            id="ice-servers"
            name="ice-servers"
            className="ice-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="stun:stun.example.com:3478, turn:user:pass@turn.example.com:3478"
            value={iceServers}
            onChange={(e) => setIceServers(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            aria-label="ICE servers (STUN/TURN)"
            aria-describedby="ice-servers-hint"
          />
          <p className="hint" id="ice-servers-hint">
            Optional. Leave blank for LAN-only (no third-party servers). To reach
            a host across the internet, supply your own self-hosted STUN/TURN —
            e.g. <code>stun:stun.example.com:3478</code> or{' '}
            <code>turn:user:pass@turn.example.com:3478</code> (comma-separated).
            If the host&apos;s signaling server already advertises ICE servers,
            those are used automatically and this override is not needed.
          </p>
        </details>
      </div>

      <nav aria-label="Discovered LAN hosts">
        <DiscoveryList onPick={pick} />
      </nav>
    </div>
  );
}
