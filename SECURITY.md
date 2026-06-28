# Security Policy

StreamScreen is a **LAN-first, peer-to-peer** remote desktop. Its security model
is built around keeping traffic on your own network and encrypted end-to-end,
with no third-party cloud in the path.

## Security model

- **DTLS-SRTP end-to-end encryption.** All media (screen, audio) and data
  channels (input, control, chat, file transfer) ride over WebRTC, whose
  peer connections are encrypted with DTLS-SRTP. Keys are negotiated directly
  between the two peers — the signaling server never sees decrypted media or
  input.
- **LAN-first, no relay.** Connections are intended to be direct peer-to-peer on
  your local network. There is **no TURN/relay server and no vendor cloud**:
  your screen and keystrokes are not proxied through anyone else's
  infrastructure. The signaling server only brokers the initial SDP/ICE
  handshake and runs on your own LAN.
- **Session codes.** A host mints (or is given) a session code that a viewer
  must present to connect. The signaling server **redacts** session codes from
  its `/api/sessions` listing unless the caller presents the configured bearer
  token (`STREAMSCREEN_TOKEN`).
- **Connection consent & access PIN (opt-in).** Beyond the session code (which is
  *addressing*, not a secret), the host can require an explicit human **Accept**
  and/or a low-entropy **access PIN** that the viewer must prove knowledge of.
  These are off by default and are described in detail below.
- **WebSocket Origin allowlisting.** The signaling server enforces an Origin
  allowlist (`STREAMSCREEN_ALLOWED_ORIGINS`); by default it accepts only
  loopback / LAN / same-host origins.
- **Optional, sandboxed-by-absence input.** Remote input injection on the host
  depends on the optional `@nut-tree-fork/nut-js` native module. If it is not
  installed, the host still streams but cannot inject input — input is the only
  capability that degrades.

There are deliberately **no accounts, no usage metering, no session time limits,
and no bitrate caps** — that is a product guarantee, not a security control. If
you expose any component beyond your LAN, do so behind your own VPN or firewall.

## Connection consent & access PIN

By default StreamScreen runs in **`open`** mode: a session is gated only by the
numeric session code, exactly as it always has been. For a stronger posture the
host operator can opt into a consent prompt and/or a secret PIN. The session code
remains pure **addressing** (which room to join); the PIN is the **secret** that
authenticates *who* may connect. The two compose — the code routes you to the
host, the PIN (and/or a human Accept) authorizes you.

### Access modes (`STREAMSCREEN_ACCESS_MODE`)

| Mode | Human Accept | PIN proof | Use case |
|---|---|---|---|
| `open` *(default)* | – | – | Code-gated only; preserves historical behavior |
| `prompt` | required | – | Attended: a human at the host approves each viewer |
| `pin` | – | required | Unattended: viewer proves a shared PIN |
| `pin-and-prompt` | required | required | Both — strongest |

The host PIN is supplied at startup via **`STREAMSCREEN_PIN`** (plaintext, read
once; never persisted). PIN policy: at least 6 characters, not all-identical
(`000000`) and not a simple sequence (`123456`).

### How the PIN is verified (zero-trust, peer-to-peer)

The PIN is **never** sent to the signaling server, and **never** sent over the
wire in any form — not even encrypted. Verification is a challenge-response that
runs **peer-to-peer over the already-encrypted DTLS data channel**:

1. **Verifier, not the PIN.** The host derives a **PBKDF2-HMAC-SHA256** key from
   the PIN (**600,000** iterations, a random **16-byte** salt, **32-byte** output
   — OWASP 2025 guidance) and stores only this *verifier* (salt + derived key).
   The plaintext PIN is never stored and cannot be recovered without
   brute-forcing the KDF.
2. **Challenge.** On a new viewer the host sends an `auth-challenge` over the
   control data channel containing a fresh random host nonce, the salt, the
   iteration count, and the **channel binding** (see below). The salt/iterations
   are public KDF parameters; the derived key is not sent. The handshake starts
   when **that viewer's `control` data channel becomes open** (not at the
   signaling join, which fires before the channel exists) — the only moment an
   auth frame can actually be delivered, so the challenge is never silently
   dropped.
3. **Proof.** The viewer derives the same key from the PIN it was given and the
   salt, then computes
   `HMAC-SHA256(derivedKey, "streamscreen-auth-v1" || nonceH || nonceV || channelBinding)`
   and returns it in an `auth-response`. The PIN itself never leaves the viewer.
4. **Verdict.** The host recomputes the expected HMAC from its stored verifier
   and compares **constant-time** (`crypto.timingSafeEqual`). The `auth-result`
   is intentionally **reason-free** on failure — it never tells an attacker
   whether the PIN, the proof, or consent was the problem.

Because the proof binds a per-handshake host nonce, a captured proof cannot be
replayed against a fresh challenge.

### Per-authorized media attach (no stream leak)

In any protected mode the host attaches the screen **per authorized viewer** — to
exactly the one connection it just authorized — never session-wide. There is no
shared/stored stream that replays onto other connections, so a viewer that is
already in the room but unapproved, or one that joins before passing its
PIN/consent, **receives nothing**: no video, no audio, no input. Only `open` mode
(no auth) attaches to everyone, which is its intended behavior.

### Channel binding (anti-MITM)

The `channelBinding` is the canonical (sorted) concatenation of the
`a=fingerprint:` DTLS certificate fingerprints from **both** peers' SDP. Both
peers see the same offer/answer, so each computes the **same** binding without
exchanging it. A man-in-the-middle that re-terminates DTLS would present a
different certificate fingerprint, so its computed binding — and therefore any
proof it could relay — would not match. The auth fails closed.

### Online brute-force defense (lockout)

The PIN is intentionally low-entropy, so the connection layer rate-limits
guessing per **(source identity + peer id)**:

- After a threshold of consecutive failed proofs (default 5) the key is **locked
  out** with **exponential backoff** (base 1s, doubling, capped at ~30 min).
- A locked key is rejected **without running the KDF/HMAC** — a rate-limited
  attacker can never make the host burn PBKDF2 CPU.
- A successful proof **resets** that key; keys are isolated so one abusive client
  cannot lock out another.
- The 600k-iteration KDF means there is no feasible **offline** brute force even
  if the verifier leaked.

The lockout state is in-memory in v1 (a host restart clears it); persisting it
across restarts is a noted follow-up.

### Fail-closed everywhere

- A PIN mode requested **without** a valid `STREAMSCREEN_PIN` does **not** silently
  downgrade to `open` — the host enters a `refuse` state and rejects **all**
  inbound connections until configured correctly.
- A consent prompt that is not answered within its timeout (default 30s)
  auto-**rejects**. (This is a per-request bound on one prompt, **not** a session
  time limit.)
- Any decode/compute error during verification counts as a failed attempt, never
  an accidental accept.

## Supported versions

This project is pre-1.0 and moves quickly. Security fixes are applied to the
`main` branch and the latest tagged release.

| Version | Supported |
|---|---|
| latest `main` / latest release | yes |
| older tags | best effort |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately using either:

1. GitHub's **private vulnerability reporting** — open the repository's
   **Security** tab and choose **Report a vulnerability**
   (`https://github.com/divyamohan1993/stream-screen/security/advisories/new`); or
2. Email the maintainer at **divyamohan1993@gmail.com** with the details.

Please include:

- the affected component (signaling / host / viewer / ai / core),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested remediation.

We will acknowledge your report, investigate, and coordinate a fix and
disclosure timeline with you. Thank you for helping keep StreamScreen users safe.
