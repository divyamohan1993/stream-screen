import React, { useState } from 'react';
import { isValidSessionCode } from '@stream-screen/core';
import { DiscoveryList } from './DiscoveryList.js';
import type { DiscoveredHost } from '../discovery-client.js';

/** Props for {@link ConnectScreen}. */
export interface ConnectScreenProps {
  /** Start a session for the given code. */
  onConnect: (code: string) => void;
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
  const valid = isValidSessionCode(code);

  const submit = (): void => {
    if (valid && !connecting) onConnect(code);
  };

  const pick = (host: DiscoveredHost): void => {
    setCode(host.code);
    if (!connecting) onConnect(host.code);
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
      </div>

      <DiscoveryList onPick={pick} />
    </div>
  );
}
