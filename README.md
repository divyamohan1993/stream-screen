# StreamScreen

**A free, unlimited-time, no-limits LAN remote desktop for Windows — over WebRTC.**

StreamScreen lets you view and control another Windows PC on your Wi‑Fi/LAN, live
and in real time, with peer-to-peer video and remote keyboard/mouse. It is
self-hosted and open: there are **no accounts, no cloud relay, no usage metering,
no bitrate caps, and — critically — no session time limits.**

> ### Why this exists
> Tools like **AnyDesk** cut you off in the free tier (the well-known ~**15‑minute
> session limit**, plus "commercial use" nags and connection throttling).
> StreamScreen has **none of that.** A session runs *exactly* as long as you keep
> it open — minutes, hours, or days. Every "free" restriction other tools impose
> (timers, watermarks, viewer caps, quality throttles) is **deliberately absent**
> here. See [ARCHITECTURE.md](./ARCHITECTURE.md#no-limits-guarantee) for the
> explicit no-limits guarantee enforced in code.

It does what a modern remote desktop should: real-time screen streaming, full
remote input, clipboard sync, adaptive quality that "auto-negotiates lag" to stay
realtime on a busy network, zero-config LAN discovery, DTLS-SRTP encryption, and
even an **AI/agent control surface** (MCP + REST) so a model can drive the remote
machine.

---

## Table of contents

- [Quickstart](#quickstart)
- [Features](#features)
- [Architecture at a glance](#architecture-at-a-glance)
- [Monorepo layout](#monorepo-layout)
- [Running each part](#running-each-part)
  - [1. Signaling server](#1-signaling-server-zero-config-lan)
  - [2. Electron host (Windows)](#2-electron-host-windows)
  - [3. Web viewer](#3-web-viewer)
- [The adaptive realtime engine](#the-adaptive-realtime-engine-auto-negotiate-lag)
- [AI-friendly control: MCP + REST](#ai-friendly-control-mcp--rest)
- [Building the Windows host (.exe)](#building-the-windows-host-exe)
- [Testing](#testing)
- [Configuration reference](#configuration-reference)
- [License](#license)

---

## Quickstart

Three terminals on the same Wi‑Fi/LAN. Node ≥ 20.

```bash
# 0) Install + build everything (workspace root)
npm install
npm run build

# 1) Start the signaling server (zero-config; binds a port + logs LAN URLs)
npm run dev:signaling
#    -> logs e.g.  ws://192.168.1.10:8787   (note this address)

# 2) On the WINDOWS machine you want to control, run the host agent.
#    It captures the screen, joins signaling, and shows a 6–9 digit code.
STREAMSCREEN_SIGNALING_URL=ws://192.168.1.10:8787 npm -w @stream-screen/host start

# 3) On any other machine, open the web viewer and enter the code (or pick the
#    host from the auto-discovered LAN list).
npm -w @stream-screen/viewer run dev
#    -> open the printed http://localhost:5173, enter the code, connect.
```

That's it — no sign-up, no relay, no timer. Media flows **peer-to-peer** between
the two machines; the signaling server only helps them find each other.

---

## Features

What a modern remote desktop should have, and where StreamScreen stands:

| Capability | Status | Notes |
|---|---|---|
| Real-time screen streaming over LAN | ✅ Implemented | WebRTC video track, host → viewer |
| Peer-to-peer media (no relay/cloud) | ✅ Implemented | Direct P2P once negotiated |
| Remote mouse (move / click / wheel) | ✅ Implemented | Resolution-independent normalized coords |
| Remote keyboard (keys + modifiers) | ✅ Implemented | DOM `code`/`key` → OS keys via nut.js |
| Clipboard sync | ✅ Implemented | Electron clipboard on host |
| **No session time limit** | ✅ Guaranteed | No timers/usage caps anywhere (vs AnyDesk's ~15 min) |
| **No bitrate / quality cap** | ✅ Guaranteed | Ceiling is only what the link sustains |
| Free & self-hosted, no accounts | ✅ Guaranteed | Session gated by a 6–9 digit code only |
| Adaptive bitrate/quality ("auto-negotiate lag") | ✅ Implemented | AIMD over RTT/loss/jitter, ~2 Hz (500 ms); **fast-down / slow-up**, governed on **end-to-end** latency (viewer reports rtt+playout) |
| Zero-config LAN discovery | ✅ Implemented | mDNS/DNS-SD (`_streamscreen._tcp`); advertises only codes of **live** host rooms |
| Session codes (6–9 digits) | ✅ Implemented | Minted by host or signaling server |
| End-to-end transport encryption | ✅ Implemented | DTLS-SRTP (WebRTC stack) |
| Multiple viewers per host | ✅ Implemented | One host, N viewers per room |
| Auto-reconnect signaling | ✅ Implemented | Exponential backoff, replays `join` |
| Cross-platform viewer | ✅ Implemented | Any modern browser |
| Windows host installer (.exe) | ✅ Implemented | electron-builder NSIS + portable |
| Multi-monitor / window selection | ✅ Implemented | Source picker + **runtime switch** via control channel (no renegotiation) |
| **AI / agent control (MCP + REST)** | ✅ Implemented | Screenshot, OCR, mouse, keyboard, monitors, chat, quality, key combos, stats |
| Screenshot + OCR of remote screen | ✅ Implemented | PNG capture + tesseract.js OCR |
| **System audio streaming** | ✅ Implemented | Host audio track over the same P2P connection; viewer mute/unmute |
| **Bidirectional file transfer** | ✅ Implemented | Chunked over a reliable `file` data channel, offer/accept handshake |
| **Session recording** | ✅ Implemented | Viewer-side MediaRecorder → downloadable `.webm` |
| **In-session chat** | ✅ Implemented | Text both directions over the `control` data channel |
| **Special key combos / Ctrl+Alt+Del** | ✅ Implemented | Ctrl+Alt+Del, Win, Alt+Tab, Win+R/D, Alt+F4, Esc + arbitrary chords |
| WAN / VPN traversal (public IP) | ⛔ Not yet | LAN-first by design; STUN/TURN hooks exist |

> The two rows that matter most for "free vs AnyDesk": **no time limit** and **no
> bitrate cap** — both are not just defaults but *guarantees enforced in the
> code* (no timer ends a healthy session; the only ceiling is link capacity).

---

## Architecture at a glance

```
   ┌──────────────────────────┐         signaling (WebSocket)         ┌──────────────────────────┐
   │   HOST  (Windows)        │   SDP offer/answer + ICE + room join  │   VIEWER  (any browser)  │
   │   Electron app           │◄────────────────────────────────────►│   Vite + React web app   │
   │                          │            ws://LAN:8787              │                          │
   │  desktopCapturer ─┐      │                                       │   <video> remote screen  │
   │  nut.js inject ◄──┤      │                                       │   input capture          │
   │  AdaptiveController│      │        mDNS discovery (LAN)           │   stats dashboard        │
   └─────────┬─────────┘      │   _streamscreen._tcp advertise/browse └─────────┬────────────────┘
             │                │                                                  │
             │     WebRTC P2P (DTLS-SRTP encrypted) — video host→viewer,        │
             └────────────────  input data channel viewer→host. NEVER relayed. ─┘
```

The signaling server is used **only** to bootstrap the connection (room join +
SDP/ICE + LAN host listing). Once the WebRTC peer connection is up, **all video
and input traffic flows directly peer-to-peer** and never touches the server
again. Full diagrams, the SDP/ICE flow, the adaptive control loop, the input
pipeline, and the security model are in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Monorepo layout

An npm-workspaces TypeScript monorepo (`packages/*` + `e2e`). Every package codes
against the shared protocol in `@stream-screen/core`.

```
stream-screen/
├── package.json              # workspace root: build / test / e2e / verify scripts
├── tsconfig.json             # project references (core → signaling → ai → host)
├── README.md                 # this file
├── ARCHITECTURE.md           # deep architecture + security model
├── packages/
│   ├── core/                 # @stream-screen/core — shared, dependency-light, runs in browser + node
│   │   └── src/
│   │       ├── protocol.ts         # SignalMessage, InputEvent, AdaptiveStats/Decision, guards
│   │       ├── peer.ts             # Peer: RTCPeerConnection wrapper, perfect negotiation, stats
│   │       ├── signaling-client.ts # SignalingClient: WS join/relay, auto-reconnect
│   │       ├── adaptive.ts         # AdaptiveController: AIMD "auto-negotiate lag" engine
│   │       ├── file-transfer.ts    # pure chunker/reassembler for the binary 'file' channel
│   │       └── input-codec.ts      # compact wire codec for InputEvents
│   ├── signaling/            # @stream-screen/signaling — zero-config LAN server
│   │   └── src/
│   │       ├── server.ts           # WebSocket SDP/ICE relay + rooms (NO time limits)
│   │       ├── discovery.ts        # mDNS/DNS-SD advertise + browse (best-effort)
│   │       ├── rest.ts             # tiny REST: /health /api/sessions /api/discover /api/code
│   │       └── index.ts            # boots HTTP + WS on one port, logs LAN URLs
│   ├── host/                 # @stream-screen/host — Electron host agent (Windows)
│   │   └── src/
│   │       ├── main.ts             # Electron main: tray, single-instance, IPC, injection
│   │       ├── capture.ts          # desktopCapturer → MediaStream (screen + system audio)
│   │       ├── monitor.ts          # enumerate displays + resolve a monitor switch
│   │       ├── file-save.ts        # persist files received over the 'file' channel
│   │       ├── host-session.ts     # capture + Peer + AdaptiveController loop
│   │       ├── input-injector.ts   # InputEvent → OS input via nut.js (optional native dep)
│   │       └── renderer/           # control window UI
│   ├── viewer/               # @stream-screen/viewer — Vite + React web viewer
│   │   └── src/
│   │       ├── viewer-session.ts   # signaling + Peer (role viewer), control/file/audio, stats
│   │       ├── input-capture.ts    # mouse/keyboard capture, normalized coords, special combos
│   │       ├── discovery-client.ts # /api/discover + /api/code
│   │       ├── quality.ts          # Auto/High/Balanced/Low presets
│   │       └── components/         # ConnectScreen, VideoStage, Toolbar (chat/files/monitors/record), StatsPanel
│   └── ai/                   # @stream-screen/ai — MCP server + mirrored REST API
│       └── src/
│           ├── tools.ts            # single source of truth: tool catalogue + pure mappers
│           ├── session.ts          # RemoteDesktopSession: viewer Peer + screenshot/OCR/input
│           ├── mcp-server.ts       # MCP (stdio) transport
│           ├── rest-api.ts         # Express REST mirror of every MCP tool
│           └── ocr.ts              # tesseract.js OCR (optional dep)
└── e2e/                      # @stream-screen/e2e — Playwright: two real Chromium peers
    ├── tests/                # session/input/adaptive + audio/file/control/keys/recording specs
    └── scripts/              # serve.mjs (signaling + fixtures), bundle-core.mjs
```

---

## Running each part

Install once at the root (workspaces hoist dependencies):

```bash
npm install
npm run build      # tsc project references + viewer typecheck
```

### 1. Signaling server (zero-config LAN)

The signaling server hosts a WebSocket SDP/ICE relay **and** a tiny REST API on a
single port (default `8787`). It advertises **live host rooms** over mDNS: a code
is advertised only once a real host has joined that room (re-synced from
`server.listSessions()` whenever a host joins or leaves), so every discovered
code maps to a joinable session rather than a placeholder minted at startup.
`listSessions()` (and `/api/sessions`) only return rooms with a currently-live
host: when the host disconnects the room is **reaped** (remaining viewers are
notified with `host-disconnected` and dropped), so a dead code is never surfaced
to mDNS or REST for a viewer to fail joining.

```bash
npm run dev:signaling                 # tsx, hot dev
# or, after build:
npm -w @stream-screen/signaling start # node dist/index.js
```

On start it logs every reachable LAN URL, e.g.:

```
[signaling] StreamScreen signaling server ready (always free, no time limits).
[signaling]   http://127.0.0.1:8787/health   ws://127.0.0.1:8787
[signaling]   http://192.168.1.10:8787/health ws://192.168.1.10:8787
```

REST endpoints: `GET /health`, `GET /api/sessions`, `GET /api/discover` (mDNS
browse), `POST /api/code` (mint a fresh code). Configure with
`STREAMSCREEN_PORT` and `STREAMSCREEN_HOST_NAME`.

### 2. Electron host (Windows)

The host is an Electron app. It captures the screen via `desktopCapturer`, sends
it P2P, and injects incoming remote input via the optional native library
`@nut-tree-fork/nut-js`. It runs in the system tray and shows the session code.

```bash
npm -w @stream-screen/host run build
STREAMSCREEN_SIGNALING_URL=ws://<server-ip>:8787 npm -w @stream-screen/host start
```

- `build` compiles TypeScript to `dist/` (entrypoint `dist/main.js`, per the
  package `main`), copies the renderer's static assets
  (`src/renderer/index.html` + CSS/images) into `dist/renderer/` via
  `scripts/copy-assets.mjs`, **and bundles the renderer + preload with esbuild**
  (`scripts/bundle.mjs`). `tsc` alone emits raw module JS that the packaged
  control window cannot run: the renderer loads as a `<script type=module>` over
  `file://` (so bare specifiers like `@stream-screen/core` won't resolve) and the
  preload runs in a sandboxed CommonJS context (so an ESM preload throws). The
  bundle step rewrites the renderer to a self-contained browser ESM (all deps
  inlined) and the preload to CommonJS (only `electron` left external), so the
  control window actually loads instead of opening blank.
- The host **mints a 6–9 digit session code** on launch (or honors
  `STREAMSCREEN_CODE`), connects to the signaling server (LAN-local by default),
  and **joins a room with that code** so the session becomes live and is
  advertised over mDNS. It surfaces/logs the code and displays it in the tray +
  control window. Startup is ordered for safety: it **acquires the screen capture
  first**, then joins and **waits for the server's `joined` acknowledgement**
  before attaching media — so if the code is already held by a live host the join
  is rejected (`host-exists`) and startup **cleans up** instead of advertising a
  room it does not own. (The join-ack wait is a connect-time bound only, never a
  session time limit.)
- Remote input injection requires the optional native dep. If it's missing,
  the host still streams; it just logs a one-time warning and ignores input
  (graceful degradation, never a crash).
- The host **never** quits on window close — it stays in the tray with **no time
  limit** until you explicitly quit.

### 3. Web viewer

Any modern browser. Connect by entering the code, or pick a host from the
auto-discovered LAN list.

```bash
npm -w @stream-screen/viewer run dev      # vite dev server (http://localhost:5173)
# or for production:
npm -w @stream-screen/viewer run build
npm -w @stream-screen/viewer run preview
```

The viewer derives its signaling WebSocket URL from the page host on port `8787`
for manually entered codes; when you instead **pick a host from the discovered
LAN list**, the viewer connects to **that host's own advertised signaling
endpoint** (`ws://<host-address>:<port>`), so a host running on another LAN
machine is reachable rather than failing with `no-such-session`. By default — with no
`STREAMSCREEN_ALLOWED_ORIGINS` configured — the signaling server accepts WS
handshakes whose browser `Origin` is loopback, the same host as the server (on
**any** port, so the Vite dev viewer on `:5173` reaches signaling on `:8787`), or
a private/link-local LAN address, while rejecting foreign public origins; set
`STREAMSCREEN_ALLOWED_ORIGINS` to an exact allowlist (or `*`) to override. It
renders the remote
screen, captures mouse/keyboard (with resolution-independent coordinates,
pointer lock, fullscreen, clipboard sync), and shows a **live adaptive-stats
dashboard** (RTT, loss, jitter, fps, resolution, current bitrate decision).

---

## Session features (audio, files, monitors, recording, chat, special keys)

Beyond the live screen + input, a session exposes a set of collaboration features
that all flow **peer-to-peer** over the same WebRTC connection — no relay, no
metering, and (like everything else here) **no time limit on any of them.** They
ride two extra data channels alongside the media track: a reliable text
`control` channel (chat, monitor enumeration/switching, audio toggle, quality,
file-transfer signaling) and a reliable binary `file` channel (the file bytes).

- **System audio streaming.** The host mixes its system/desktop audio into the
  captured stream and negotiates it as an audio track on the *same* peer
  connection as the video — no second connection. The viewer plays it inline and
  exposes a **mute/unmute** toggle (it flips the inbound track's `enabled` flag,
  a receive-side control) and can ask the host to start/stop capture with an
  `audio` control message.

- **Bidirectional file transfer.** Drag a file onto the viewer (or push from the
  host) to send it across. The sender emits a `file-offer` on the `control`
  channel; the peer auto-accepts with `file-accept`; the bytes stream as 16 KiB
  self-framed chunks over the reliable binary `file` channel; a final
  `file-complete` closes it. Each binary chunk embeds its **own transfer id**
  (a uint16-length-prefixed id ahead of the `seq`+`len` header), so several
  concurrent transfers can share the single `file` channel — every frame is
  routed to its transfer by id, so picking multiple files (offers overlapping in
  flight) never cross-contaminates the streams. The receiver reassembles
  deterministically and verifies length; progress is surfaced via
  `file-progress`. On the Windows host, received files are written to disk
  (`host/src/file-save.ts`).

- **Multi-monitor switching at runtime.** The host enumerates its displays
  (`MonitorInfo`: id, name, primary, width, height). The viewer requests the list
  (`request-monitors`), shows a picker, and switches the streamed display
  (`switch-monitor`). The host swaps the outbound video track **in place**
  (`replaceTrack`, no SDP renegotiation) and acks with `monitor-switched`, so the
  switch is near-instant and never tears down the session.

- **Session recording.** The viewer can record the incoming remote `MediaStream`
  with the browser's `MediaRecorder` and save a downloadable **`.webm`**. Recording
  is entirely viewer-side and local; nothing is uploaded and there is no length
  cap — record for as long as the session runs.

- **In-session chat.** Text messages round-trip in both directions over the
  `control` channel (`chat` messages, timestamped), so the operator and viewer
  can talk without a separate tool.

- **Special key combos / Ctrl+Alt+Del.** The viewer can send chords the browser
  would otherwise swallow: **Ctrl+Alt+Del** (Secure Attention Sequence), the
  **Win** key, **Alt+Tab**, **Win+R**, **Win+D**, **Alt+F4**, **Esc**, plus any
  arbitrary modifier+key combo. `buildKeyCombo` / `SPECIAL_KEYS`
  (`core/src/protocol.ts`) build an ordered key-down/up sequence with the correct
  cumulative modifier bitmask, sent over the input channel and replayed by the
  host injector. A modifier pressed on its own key event stays physically held
  until **its own** key-up — it is never released by an unrelated non-modifier
  key-up — so chords like **Ctrl+Tab** cycling and **Shift+Arrow** selection keep
  the modifier down across the repeats.

  **Ctrl+Alt+Del routing (Windows SAS).** The Ctrl+Alt+Del chord arrives over the
  ordinary input channel as individual key events, but a synthetic Ctrl+Alt+Del is
  *ignored* by the Windows **Secure Attention Sequence (SAS)** on the secure
  desktop. The host therefore detects the chord (a `Delete` key-down with both
  Ctrl and Alt held) in `HostSession` and routes it to the real `SendSAS` API
  (`input-injector.ts`) instead of replaying the keys. **Requirement:**
  software-initiated SAS requires the **`SoftwareSASGeneration`** group policy to
  be enabled on the host (Computer Configuration → Administrative Templates →
  Windows Components → Windows Logon Options → *Disable or enable software Secure
  Attention Sequence* → **Enabled / Services and Ease of Access applications**).
  Without that policy `SendSAS` no-ops and the host falls back to the synthetic
  chord (still useful for in-app shortcuts and relaxed/kiosk configs).

> Unlike AnyDesk — which gates file transfer, session recording, and even some
> input behind paid tiers and the ~15-minute free cutoff — every feature here is
> free, self-hosted, and never times out or meters usage.

---

## The adaptive realtime engine ("auto-negotiate lag")

The single most important piece for staying realtime on a real Wi‑Fi network is
the **`AdaptiveController`** in `@stream-screen/core` (`adaptive.ts`). It is a
research-grade **AIMD** (additive-increase / multiplicative-decrease) congestion
controller driven by live WebRTC stats. It is tuned to **always prioritize
real-time** while pushing the best quality the link can actually sustain: it
backs off **fast** and ramps up **slowly**, and it governs on the **true
end-to-end interactive latency** the viewer experiences — not just the host's
own wire RTT.

Every **~500 ms** the host runs this loop (`HostSession.tick`,
`ADAPTIVE_INTERVAL_MS = 500`):

```
peer.getStats()  ─┐
                  ├─►  AdaptiveController.update(stats)  ──►  peer.applyDecision(decision)
viewer { t:latency }─┘     choose bitrate / fps /         (applied fast-down / slow-up)
  rtt + playout (E2E)      resolution downscale            setParameters() on the sender
```

How it decides:

- **INCREASE** — link is clean (RTT < target **and** end-to-end latency < target,
  loss < 2%, low jitter): grow the target bitrate by ~8%, but never sprint past
  measured `availableOutgoingBitrate`.
- **DECREASE** — congested (loss > 5%, **end-to-end latency** > 1.6× target, or
  jitter spike): back off multiplicatively, with a severity-scaled factor
  (0.85 mild → 0.60 hard) so the response is fast but proportionate. If the link
  reports lower headroom, it's respected immediately.
- **HOLD** — ambiguous region: keep steady to avoid oscillation.

**Fast-down / slow-up (always favor real-time).** The control loop ticks at
~2 Hz (500 ms), halving the worst-case reaction time to a congestion event vs the
old 1 Hz. Application is **asymmetric**: a **DECREASE or HOLD applies immediately,
every tick**, but an **INCREASE only commits after `INCREASE_CONFIRM_TICKS = 4`
consecutive clean samples** (~2 s of sustained healthy link). Any non-increase
classification resets that counter. So a single clean blip never bumps quality,
but a genuinely-recovered link still ramps promptly — we shed quality the instant
the link hurts and re-earn it only once it's proven stable. The controller's math
is untouched and authoritative; the host only gates *when* to push an increase to
the encoder, never *what* the value is (the counter is a deterministic integer, so
it's unit-tested).

**End-to-end interactive-latency feedback (closed loop).** Wire RTT alone
understates what the user feels: a decoded frame still waits in the viewer's
jitter/playout buffer before it's drawn. Only the **viewer** can measure that
receive-side delay, so every tick the viewer reports its observed
`{ t:'latency', rttMs, playoutMs, fps }` back to the host over the reliable
`control` channel (`ViewerSession`; `Peer.getLocalTelemetry()` derives it from
`jitterBufferDelay / jitterBufferEmittedCount`, delta-averaged over the last
window). The host folds the **worst-case** reported `rttMs`/`playoutMs` across all
viewers into the stats it hands the controller (`max` of measured vs reported), so
the engine backs off on the **true perceived latency** — receiver-side queueing
forces a real-time backoff even when the host's own sender RTT looks fine. When no
viewer reports (or `playoutMs` is 0), `realtime === rttMs` and behavior is
byte-identical to before.

From the chosen bitrate it derives a **max framerate** (15…60 fps) and a
**resolution downscale** (1 / 1.5 / 2 / 3 / 4), so low-bandwidth links shed
framerate and resolution *gracefully* instead of stalling — the "auto-negotiate
lag to stay realtime" behavior. The controller is **pure and deterministic** (no
timers, no randomness), which is why it is directly unit-tested.

There is **no bitrate ceiling** beyond the caller-supplied `maxKbps` (default
40 Mbps) and **no time-based throttle of any kind** — the 500 ms tick and the
4-sample increase gate are *control-loop cadence*, never a session limit.

**Proven end-to-end.** A Playwright closed-loop e2e
(`e2e/tests/adaptive-closed-loop.spec.ts`) brings up a *real* two-Chromium WebRTC
session and drives the *real* pipeline: it feeds the live `AdaptiveController` a
stats sequence, calls `peer.applyDecision()` on the live connection, and reads the
encodings straight off the real `RTCRtpSender`. It proves (a) network congestion
drops the real sender's `maxBitrate`/`maxFramerate` and raises
`scaleResolutionDownBy`; (b) **receiver-side `playoutMs` alone** (wire RTT under
target) forces a backoff — real-time, not just RTT; (c) a sustained clean link
recovers the real bitrate well above the trough; and (d) the viewer's
`{ t:latency }` telemetry round-trips and the host receives the exact values — the
feedback edge of the loop, closed against actual WebRTC rather than a mock.

---

## AI-friendly control: MCP + REST

`@stream-screen/ai` exposes the *same* remote-desktop control surface in two
transports, generated from one shared tool registry (`tools.ts`) so they can
never drift:

- **MCP server** over stdio — for Model Context Protocol agents.
- **REST API** (Express) — for any non-MCP automation.

Both drive a single `RemoteDesktopSession`, which connects as a **viewer** via the
core `Peer`. `list_hosts` queries the signaling server's REST API over HTTP
(`GET /api/discover`, falling back to `/api/sessions`) — the HTTP base URL is
derived from the signaling WS URL or set via `STREAMSCREEN_SIGNALING_HTTP_URL` —
so every returned code maps to a live, joinable host room. When `/api/discover`
advertises a host's own `address`/`port`, `list_hosts` carries that host's
signaling endpoint (`ws://address:port`) through with the code, so a later
`connect(code)` joins against **that** host's signaling server rather than this
AI server's configured `signalingUrl` — a host on another LAN machine is reachable
instead of failing with `no-such-session` (pass an explicit `signalingUrl` to
`connect` to override). Codes are validated
against the 6–9 digit pattern and any unusable one is dropped, so `list_hosts`
never surfaces a code `connect` would reject; in particular the `/api/sessions`
fallback **redacts** codes (e.g. `****56`) for unauthenticated callers, so set
`STREAMSCREEN_TOKEN` (sent as a bearer token) to obtain un-redacted, joinable
codes from that fallback. A node WebRTC runtime
(`@roamhq/wrtc`) and OCR (`tesseract.js`) are
**optional**: without them the server, tool list, and schemas stay fully valid and
the affected calls return a clear "requires native webrtc runtime" / "OCR
unavailable" message. **Nothing here counts usage or expires a session.**

### Tool table

| Tool (MCP) | REST route | Args | Returns |
|---|---|---|---|
| `list_hosts` | `GET /api/hosts` | – | live hosts via the signaling REST API (`GET /api/discover`, falling back to `/api/sessions`) |
| `connect` | `POST /api/connect` | `{ code, signalingUrl? }` | establishes the P2P session (a discovered host's advertised endpoint is used automatically; `signalingUrl` overrides) |
| `disconnect` | `POST /api/disconnect` | – | closes the session |
| `screenshot` | `GET /api/screenshot` | – | current frame as PNG |
| `ocr_screen` | `GET /api/ocr` | – | recognized text from the screen |
| `move_mouse` | `POST /api/move` | `{ x, y }` (0..1) | moves the cursor |
| `click` | `POST /api/click` | `{ x, y, button? }` | press + release (0=L,1=M,2=R) |
| `type_text` | `POST /api/type` | `{ text }` | types a string |
| `press_key` | `POST /api/key` | `{ key, mods? }` | key down/up; `mods` bitflags 1/2/4/8 |
| `get_stats` | `GET /api/stats` | – | live RTT/loss/jitter/fps/resolution/bitrate |
| `list_monitors` | `GET /api/monitors` | – | host's displays (`id, name, primary, w, h`) |
| `switch_monitor` | `POST /api/monitor` | `{ id }` | switch the streamed display (in-place track swap) |
| `send_chat` | `POST /api/chat` | `{ text }` | send a chat message to the host operator |
| `set_quality` | `POST /api/quality` | `{ preset }` | `auto` \| `high` \| `balanced` \| `low` |
| `send_keys` | `POST /api/keys` | `{ keys }` | press an arbitrary chord, e.g. `["ctrl","alt","delete"]` |
| `press_combo` | `POST /api/combo` | `{ combo }` | named combo: `ctrl+alt+del`, `win`, `alt+tab`, `win+r`, `win+d`, `alt+f4`, `escape` |

Coordinates are always **normalized fractions in [0,1]** of the remote screen, so
they're resolution-independent. Modifier bitflags: `1`=shift, `2`=ctrl, `4`=alt,
`8`=meta (combine by OR-ing, e.g. ctrl+shift = `3`). For multi-key chords prefer
`send_keys` (arbitrary, e.g. `["ctrl","alt","delete"]`) or `press_combo` (named,
e.g. `ctrl+alt+del`) over hand-rolling `press_key` with modifiers.

### Run it

```bash
# MCP server (stdio) — default
STREAMSCREEN_SIGNALING_URL=ws://<server-ip>:8787 npm -w @stream-screen/ai start

# REST API on :8788
STREAMSCREEN_AI_MODE=rest STREAMSCREEN_AI_PORT=8788 \
STREAMSCREEN_SIGNALING_URL=ws://<server-ip>:8787 npm -w @stream-screen/ai start
```

### Example REST calls

```bash
# Discover hosts, then connect by code
curl http://localhost:8788/api/hosts
curl -X POST http://localhost:8788/api/connect -H 'content-type: application/json' -d '{"code":"123456"}'

# Look at the screen
curl http://localhost:8788/api/screenshot -o screen.png
curl http://localhost:8788/api/ocr

# Control it (normalized coordinates)
curl -X POST http://localhost:8788/api/move  -H 'content-type: application/json' -d '{"x":0.5,"y":0.5}'
curl -X POST http://localhost:8788/api/click -H 'content-type: application/json' -d '{"x":0.5,"y":0.5,"button":0}'
curl -X POST http://localhost:8788/api/type  -H 'content-type: application/json' -d '{"text":"hello"}'
curl -X POST http://localhost:8788/api/key   -H 'content-type: application/json' -d '{"key":"Enter"}'

# Multi-monitor: list displays, then switch the streamed one
curl http://localhost:8788/api/monitors
curl -X POST http://localhost:8788/api/monitor -H 'content-type: application/json' -d '{"id":"screen:1:0"}'

# Chat to the operator; pin a quality preset (auto|high|balanced|low)
curl -X POST http://localhost:8788/api/chat    -H 'content-type: application/json' -d '{"text":"connecting now"}'
curl -X POST http://localhost:8788/api/quality -H 'content-type: application/json' -d '{"preset":"high"}'

# Special key combos: an arbitrary chord, or a named one (e.g. Ctrl+Alt+Del)
curl -X POST http://localhost:8788/api/keys    -H 'content-type: application/json' -d '{"keys":["ctrl","alt","delete"]}'
curl -X POST http://localhost:8788/api/combo   -H 'content-type: application/json' -d '{"combo":"ctrl+alt+del"}'

# Health + capabilities (advertises: limits none, cost free)
curl http://localhost:8788/health
```

To register the MCP server with an agent, point it at
`node packages/ai/dist/index.js` as a stdio MCP server (env
`STREAMSCREEN_SIGNALING_URL` set to your signaling URL).

---

## Building the Windows host (.exe)

The host ships as a Windows installer and a portable executable via
**electron-builder** (`packages/host/electron-builder.yml`).

```bash
npm -w @stream-screen/host run build   # compile TypeScript to dist/
npm -w @stream-screen/host run dist    # electron-builder --win
```

Outputs land in `packages/host/release/`:

- **NSIS installer** — `StreamScreen Host-<version>-x64.exe` (per-user install,
  custom install dir allowed).
- **Portable** — `StreamScreen Host-<version>-portable.exe` (no install).

The optional native input library (`@nut-tree-fork/nut-js`) is `asarUnpack`ed
when present on the build machine, so a built installer that includes it has full
remote-control capability; if it was absent at build time, the app still installs
and streams (input is the only thing that degrades).

> Build the Windows artifacts on Windows (or a Windows CI runner) for native
> module compatibility.

---

## Testing

Unit tests use **Vitest** across every package; end-to-end uses **Playwright**
driving **two real Chromium peers** through the live signaling server.

```bash
# Everything: build + unit tests + e2e
npm run verify

# Or individually:
npm run build                 # tsc project refs + viewer typecheck
npm test                      # unit tests across all workspaces (vitest)
npm run e2e                   # Playwright e2e (bundles core, serves fixtures)
```

What the **e2e** suite proves (no mocks for the hard parts) — **15 Playwright
specs**, two real Chromium peers each:

- **`session.spec`** — host + viewer establish a *real* WebRTC P2P session; the
  viewer receives decoded video frames and the input data channel opens.
- **`input.spec`** — input events actually flow viewer → host over the data
  channel and decode correctly.
- **`adaptive.spec`** — the adaptive engine, exercised in-page, ramps up on a
  clean link and backs off under loss/RTT/jitter.
- **`adaptive-closed-loop.spec`** — the **closed loop against real WebRTC**: on a
  live two-Chromium session the host drives the real `AdaptiveController` and calls
  `peer.applyDecision()`, then reads the encodings off the **real `RTCRtpSender`**.
  Proves congestion (loss/RTT/jitter) drops the real sender's
  bitrate/framerate and raises the resolution downscale; that **receiver-side
  `playoutMs` alone** (wire RTT under target) forces a real-time backoff; that a
  sustained clean link **recovers** the real bitrate above the trough; and that the
  viewer's `{ t:latency }` interactive-latency telemetry round-trips to the host
  over the real `control` channel (the feedback edge of the loop).
- **`audio.spec`** — the viewer receives a *live* system-audio track from the
  host over the same peer connection, and the mute/unmute toggle flips the
  inbound track's `enabled` flag.
- **`file-transfer.spec`** — a multi-chunk (>3×16 KiB) file streams viewer → host
  over the real `file` data channel and reassembles with exact length and
  checksum (offer → accept → chunks → complete).
- **`file-transfer-h2v.spec`** — the same transfer in the **host → viewer**
  direction: a 50 KB file (4 of the 16 KiB chunks) streams over the real `file`
  channel and reassembles on the viewer with exact length and checksum.
- **`control.spec`** — multi-monitor enumeration + runtime switch (host acks
  `monitor-switched` after an in-place `replaceTrack`) and chat round-tripping in
  both directions over the `control` channel.
- **`keys.spec`** — Ctrl+Alt+Del / Win / arbitrary combos arrive on the host as
  the exact ordered key events with the correct cumulative modifier bitmask.
- **`recording.spec`** — the viewer records the incoming remote stream with
  `MediaRecorder` and produces a real `.webm`: non-empty output whose first four
  bytes are the EBML magic (`0x1A 0x45 0xDF 0xA3`).

Per-package tests can also be run directly, e.g.
`npm -w @stream-screen/core test` or `npm -w @stream-screen/viewer test`.

---

## Configuration reference

| Env var | Used by | Default | Meaning |
|---|---|---|---|
| `STREAMSCREEN_PORT` | signaling | `8787` | HTTP+WS port |
| `STREAMSCREEN_HOST_NAME` | signaling, host | machine hostname | advertised name |
| `STREAMSCREEN_SIGNALING_URL` | host, ai | `ws://127.0.0.1:8787` | signaling WS URL |
| `STREAMSCREEN_SIGNALING_HTTP_URL` | ai | derived from WS URL | signaling REST base for `list_hosts` |
| `STREAMSCREEN_TOKEN` | ai | – | bearer token for `/api/sessions` to get un-redacted codes |
| `STREAMSCREEN_ALLOWED_ORIGINS` | signaling | – | comma-separated WS Origin allowlist (or `*`); default accepts loopback/LAN/same-host |
| `STREAMSCREEN_CODE` | host | minted | fixed session code |
| `STREAMSCREEN_AI_MODE` | ai | `mcp` | `rest` to run the REST API |
| `STREAMSCREEN_AI_PORT` | ai | `8788` | REST port |
| `VITE_SIGNALING_HTTP` | viewer | `http://localhost:8787` | dev proxy target |

---

## License

Free and self-hosted. StreamScreen imposes **no time limits, no usage caps, no
bitrate ceilings, and no accounts** — by design and in code. See
[ARCHITECTURE.md](./ARCHITECTURE.md#no-limits-guarantee).
</content>
