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
