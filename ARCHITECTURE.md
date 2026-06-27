# StreamScreen Architecture

StreamScreen is a free, unlimited-time, LAN-first remote desktop for Windows.
Video and input flow **peer-to-peer over WebRTC**; a tiny signaling server only
helps the two peers find each other and exchange the WebRTC handshake. This
document covers the component model, the signaling/SDP/ICE flow, the adaptive
control loop, the input pipeline, and the security model — and states explicitly
that **there are no time limits or usage caps anywhere in the system.**

- [Components](#components)
- [Component diagram](#component-diagram)
- [Signaling / SDP / ICE flow](#signaling--sdp--ice-flow)
- [LAN discovery (mDNS)](#lan-discovery-mdns)
- [The adaptive control loop](#the-adaptive-control-loop)
- [The input pipeline](#the-input-pipeline)
- [Session features over the control & file channels](#session-features-over-the-control--file-channels)
- [AI control layer (MCP + REST)](#ai-control-layer-mcp--rest)
- [Security model](#security-model)
- [No-limits guarantee](#no-limits-guarantee)

---

## Components

An npm-workspaces TypeScript monorepo. Everything is built on the shared contract
in `@stream-screen/core`, which is intentionally dependency-light so the same code
runs identically in a browser and in node.

| Package | Runtime | Role |
|---|---|---|
| `@stream-screen/core` | browser + node | Protocol types + runtime building blocks: `Peer` (WebRTC), `SignalingClient`, `AdaptiveController`, input codec. |
| `@stream-screen/signaling` | node | Zero-config LAN server: WebSocket SDP/ICE relay + rooms, mDNS discovery, tiny REST API. |
| `@stream-screen/host` | Electron (Windows) | Captures screen + system audio, enumerates/switches monitors, runs the adaptive loop, injects remote input incl. special combos (`nut.js`), saves received files, tray UI. |
| `@stream-screen/viewer` | browser (Vite + React) | Renders the remote screen+audio, captures input, file transfer, monitor switching, recording, chat, live stats dashboard. |
| `@stream-screen/ai` | node | MCP (stdio) server + mirrored REST API so AI agents can drive a session (incl. monitors, chat, quality, key combos). |
| `@stream-screen/e2e` | node + Chromium | Playwright: two real browser peers run a live WebRTC session (15 specs: session/input/adaptive/adaptive-closed-loop/audio/file (both directions + concurrent)/control/keys/recording). |

---

## Component diagram

```mermaid
flowchart LR
  subgraph HOST["HOST — Electron (Windows)"]
    DC["desktopCapturer\n(main process)"]
    HS["HostSession\n(renderer)"]
    AC["AdaptiveController"]
    II["InputInjector\n(nut.js, optional)"]
    DC --> HS
    HS --> AC
    HS -->|inject IPC| II
  end

  subgraph SIG["SIGNALING SERVER (node) — one port"]
    WS["WebSocket relay\n(rooms by code)"]
    REST["REST API\n/health /sessions /discover /code"]
    MDNS["mDNS / DNS-SD\n_streamscreen._tcp"]
  end

  subgraph VIEW["VIEWER — browser (or AI session)"]
    VS["ViewerSession"]
    IC["input-capture"]
    SP["StatsPanel"]
    VS --> SP
    IC --> VS
  end

  HS <-->|"SDP offer/answer + ICE\n(bootstrap only)"| WS
  VS <-->|"SDP offer/answer + ICE\n(bootstrap only)"| WS
  MDNS -.->|advertise / browse| VIEW

  HS ==>|"WebRTC video + audio tracks (DTLS-SRTP)"| VS
  VS ==>|"WebRTC data channels: input / control / file"| HS

  classDef p2p stroke-width:3px;
  class HS,VS p2p;
```

The thick `==>` arrows are the **peer-to-peer** WebRTC media/data paths. They are
direct between host and viewer and never traverse the signaling server. The thin
`<-->` arrows are the bootstrap-only signaling exchange.

If your Markdown renderer does not support Mermaid, here is the same topology in
ASCII:

```
   HOST (Electron, Windows)            SIGNALING (node, one port)         VIEWER (browser / AI)
   ─────────────────────────          ──────────────────────────         ─────────────────────
   desktopCapturer ─┐                  WebSocket relay (rooms)            ViewerSession ─► StatsPanel
                    ▼                   REST /health /sessions             ▲
            HostSession ──► Adaptive        /discover /code                │
                    │       Controller     mDNS _streamscreen._tcp     input-capture
       inject IPC   ▼                  ──────────────────────────
            InputInjector(nut.js)
                    ▲                          ▲          ▲
                    │   SDP/ICE (bootstrap)    │          │   SDP/ICE (bootstrap)
                    └──────────────────────────┘          └──────────────────────┐
                                                                                  │
   HOST ===== WebRTC video track (DTLS-SRTP, P2P) ============================►  VIEWER
   HOST ◄==== WebRTC data channel: InputEvents (DTLS-SRTP, P2P) ===============  VIEWER
                       (P2P paths NEVER traverse the signaling server)
```

---

## Signaling / SDP / ICE flow

Signaling exists **only** to set up the WebRTC connection. The server groups
peers into a *room* keyed by the 6–9 digit session code, relays SDP and ICE, and
emits lifecycle events. It carries **no media and no input** — once the peer
connection is established, application traffic is fully peer-to-peer.

Negotiation uses the WebRTC **perfect-negotiation** pattern (`core/peer.ts`):
the **host is impolite** (wins glare, offers first); the **viewer is polite**
(rolls back on collision).

```mermaid
sequenceDiagram
  participant H as Host (impolite)
  participant S as Signaling server
  participant V as Viewer (polite)

  H->>S: join { role: host, code }
  S-->>H: joined { from: hostId, code }

  V->>S: join { role: viewer, code }
  S-->>V: joined { from: viewerId }
  S-->>V: peer-joined { from: hostId }
  S-->>H: peer-joined { from: viewerId }

  Note over H: viewer present + stream attached -> create offer
  H->>S: offer { to: viewerId, sdp }
  S-->>V: offer { from: hostId, sdp }
  V->>S: answer { to: hostId, sdp }
  S-->>H: answer { from: viewerId, sdp }

  par ICE trickle (both directions)
    H->>S: ice { candidate }
    S-->>V: ice { from: hostId, candidate }
    V->>S: ice { candidate }
    S-->>H: ice { from: viewerId, candidate }
  end

  Note over H,V: DTLS handshake -> SRTP media + data channel OPEN
  H-->>V: video track (P2P, encrypted)
  V-->>H: InputEvents over data channel (P2P, encrypted)

  Note over S: server is now idle for this session - no relay, no timer
```

Key points:

- **Rooms by code.** A host without a code mints one; viewers must target an
  existing room (`no-such-session` otherwise). One host + N viewers per room.
- **Join is acknowledged.** A successful `join` (host or viewer) gets a `joined`
  reply addressed to the joining socket. The host **awaits this ack** before
  treating the room as its own (see below), so a rejected or unanswered join
  never proceeds as if it succeeded.
- **One host per code.** A second `join` with `role: host` for a code already
  held by a live host is **rejected with an `error` whose code/message is
  `host-exists`**, and the second socket is *not* registered as that room's host
  — so a duplicate `STREAMSCREEN_CODE` cannot hijack or shadow a live session.
- **`peer-left` carries role.** Every `peer-left` includes the departed peer's
  `role` (`host` | `viewer`), so a viewer can tell "the host went away" from
  "another viewer left" (only the former returns it to `waiting-for-host`).
- **The server overwrites `from`** with the sender's authoritative id, so peers
  can't spoof each other within a room. `to` targets a specific peer; otherwise a
  message broadcasts to the rest of the room.
- **Auto-reconnect.** `SignalingClient` reconnects with exponential backoff
  (250 ms -> 8 s) and replays the last `join`, so a dropped Wi‑Fi signaling socket
  transparently rejoins. This is reconnection, **not** a session timer.
- **Keepalive != timeout.** A WebSocket ping/pong heartbeat reaps *dead* sockets
  (crashed peer, dropped Wi‑Fi) so `peer-left` fires promptly. It never ends a
  *healthy* session. See [No-limits guarantee](#no-limits-guarantee).
- **Brute-force join throttle.** Repeated failed `join`s are rate-limited per
  source within a sliding window. The throttle key is the real TCP peer
  (`req.socket.remoteAddress`); the client-supplied `X-Forwarded-For` header is
  ignored by default since this is a LAN-direct service and XFF is forgeable
  (rotating it would dodge the per-source budget). Set `STREAMSCREEN_TRUST_PROXY`
  (or `trustProxy: true`) only when behind a trusted reverse proxy to honor the
  left-most XFF entry as the client address.
- **Executable bin.** The signaling entrypoint (`src/index.ts`) begins with a
  `#!/usr/bin/env node` shebang so the `streamscreen-signaling` bin
  (package.json `bin` → `dist/index.js`) runs directly on Unix.
- **Host start ordering + ack.** `HostSession.start` (`host/host-session.ts`)
  **acquires the capture stream first**, then connects, joins as host, and
  **awaits the `joined` acknowledgement** before attaching media and starting the
  adaptive loop. Any failure along the way — capture rejection, a `host-exists`
  rejection, or a join-ack timeout (`JOIN_ACK_TIMEOUT_MS`, a connect-time bound
  only, **not** a session limit) — fully **tears down via `stop()`**, so a failed
  start never leaves a dangling joined socket or a live advertised room with no
  media behind it.
- **Viewer join ack + teardown.** `ViewerSession.connect` (`viewer/viewer-session.ts`)
  symmetrically **awaits the `joined` acknowledgement** before reporting
  connected, entering `waiting-for-host`, installing the persistent signaling
  error handler, or starting the stats loop. A rejected viewer join
  (`no-such-session` for a code naming no live host, or a full room) or a
  join-ack timeout (`VIEWER_JOIN_ACK_TIMEOUT_MS`, a connect-time bound only,
  **not** a session limit) throws `ViewerJoinRejectedError` and fully tears the
  session down — closing the peer and **closing the `SignalingClient`** so its
  remembered `lastJoin` can never reconnect and replay a rejected join. The same
  ack gate guards the ICE-reconnect peer rebuild, and a rejected/timed-out rebuild
  join gets the **identical full teardown** (`teardownForError`): the freshly-built
  peer and the SignalingClient are closed and the stats loop stopped, so a failed
  rebuild ends cleanly in `error` instead of leaving a dangling peer plus a socket
  that keeps reconnecting and replaying the rejected join. `App.connect` also disconnects
  any prior session before creating a new one, guaranteeing at most one live
  session.

---

## LAN discovery (mDNS)

The signaling server advertises a `_streamscreen._tcp` service over mDNS/DNS-SD
(Bonjour/Avahi) carrying the host name, signaling port, and the session code in
TXT records. **Discovery is truthful: it advertises the codes of ACTUAL live host
rooms, never a placeholder minted at startup with no host behind it.** The server
re-syncs the advertised set from `SignalingServer.listSessions()` whenever a host
joins (room becomes live ⇒ publish that code) or leaves (room reaped ⇒ withdraw
it), via a `sessions-changed` event. `listSessions()` only counts rooms with a
currently-live host, and when a host disconnects its room is reaped immediately
(any lingering viewers get `host-disconnected` and are dropped) — so a hostless
room never lingers to feed a dead code to discovery or `/api/sessions`. Multiple
concurrent hosts each get their own
advertisement, and only valid 6–9 digit codes are published. The Electron host
makes this work end-to-end: it connects to the signaling server (LAN-local by
default) and joins a room with a stable code (`STREAMSCREEN_CODE` or generated),
so its session goes live and its code is advertised. Net effect: every discovered
code maps to a joinable live host room. Any machine on the same LAN can browse for
these and present a one-tap list — **zero configuration, no cloud, no accounts.**
If a host ever advertises an empty/invalid code (e.g. an mDNS race before it is
ready), the viewer prefills the field and waits for confirmation instead of
auto-connecting with a bad code.

**Cross-machine discovery connects to the host's own signaling endpoint.** A host
found over mDNS advertises its `address`/`port`, and that host runs its *own*
signaling server at that address. When the viewer picks a discovered host it
connects to *that* host's advertised `ws://address:port`
(`signalingUrlForHost`, IPv6 bracketed), not the viewer's default
`localhost:8787` — otherwise a host on another LAN machine would be unreachable
and the join would fail with `no-such-session`. Manual code entry has no
advertised endpoint and falls back to the viewer's default signaling URL.

mDNS is **best-effort and fully guarded**: on locked-down networks or sandboxes
where UDP multicast is blocked, advertise/browse degrade to graceful no-ops
(`available = false`) instead of crashing. Manual code entry always works without
discovery. Viewers reach discovery via `GET /api/discover`.

---

## The adaptive control loop

The "auto-negotiate lag" engine (`core/adaptive.ts`, driven by
`host/host-session.ts`) keeps the stream realtime on a busy network. It is a
deterministic **AIMD** (additive-increase / multiplicative-decrease) congestion
controller — no timers, no randomness, so it is directly unit-testable. It is
tuned to **always prioritize real-time** while pushing the best quality the link
can sustain: a **fast-down / slow-up** application policy at ~2 Hz, and it governs
on the **true end-to-end interactive latency** the viewer experiences rather than
only the host's own wire RTT.

```mermaid
flowchart TB
  T["every ~500ms (ADAPTIVE_INTERVAL_MS = 500)"] --> G["peer.getStats()"]
  VL["viewer { t:latency }\nrttMs + playoutMs + fps\n(over control channel)"] --> FOLD
  G --> FOLD["fold in worst-case viewer latency\n(max of measured vs reported rtt/playout)"]
  FOLD --> S["AdaptiveStats:\nrtt, loss%, jitter, availableKbps,\nfps, w x h, playoutMs (E2E)"]
  S --> C{classify link}
  C -->|"clean: rtt<target AND rtt+playout<target,\nloss<2%, low jitter"| INC["INCREASE\nx1.08, capped at availableKbps x1.05"]
  C -->|"congested: loss>5% OR rtt+playout>1.6xtarget OR jitter spike"| DEC["DECREASE\nx(0.85 -> 0.60 by severity)"]
  C -->|ambiguous| HOLD["HOLD\nkeep steady"]
  INC --> CLAMP["clamp to [minKbps, maxKbps]"]
  DEC --> CLAMP
  HOLD --> CLAMP
  CLAMP --> D["AdaptiveDecision:\ntargetKbps, maxFramerate (15-60),\nscaleResolutionDownBy (1-4)"]
  D --> GATE{"asymmetric apply\n(fast-down / slow-up)"}
  GATE -->|"DECREASE / HOLD: apply NOW"| A["peer.applyDecision()\nsender.setParameters()"]
  GATE -->|"INCREASE: only after 4 clean ticks\n(INCREASE_CONFIRM_TICKS)"| A
  A --> T
```

- **Inputs** come from the WebRTC stats API: candidate-pair RTT and
  `availableOutgoingBitrate`; inbound/outbound and remote-inbound RTP for
  loss, jitter, fps, and frame size; and the receiver's playout/jitter-buffer
  delay (`jitterBufferDelay / jitterBufferEmittedCount`, delta-averaged over the
  last window) as `playoutMs`.
- **End-to-end latency feedback (closed loop).** Wire RTT understates perceived
  lag: a decoded frame still waits in the viewer's jitter/playout buffer before it
  is drawn, and only the *viewer* can measure that receive-side delay. So every
  tick the viewer reports `{ t:'latency', rttMs, playoutMs, fps }` to the host over
  the reliable `control` channel (`ViewerSession`, via `Peer.getLocalTelemetry()`).
  The host folds the **worst-case** (`max`) reported `rttMs`/`playoutMs` across all
  viewers into the stats it hands the controller, so the engine classifies on
  `realtimeMs = rttMs + playoutMs` — receiver-side queueing forces a real-time
  backoff even when the host's own sender RTT looks fine. With no report (or
  `playoutMs = 0`), `realtime === rttMs` and behavior is identical to before.
- **Fast-down / slow-up application.** The loop ticks at 500 ms
  (`ADAPTIVE_INTERVAL_MS`), halving worst-case reaction time vs the prior 1 Hz.
  Application is **asymmetric**: a **DECREASE or HOLD applies immediately, every
  tick**, while an **INCREASE commits only after `INCREASE_CONFIRM_TICKS = 4`
  consecutive clean classifications** (~2 s of sustained healthy link, tracked by a
  deterministic integer counter that any non-increase decision resets). The
  controller's bitrate math stays authoritative and untouched; the host only gates
  *when* to push an increase to the encoder, never *what* the value is — so we shed
  quality the instant the link hurts and re-earn it only once it is proven stable.
- **Outputs** are applied to the outbound video sender's first encoding:
  `maxBitrate`, `maxFramerate`, `scaleResolutionDownBy` (degradationPreference
  `maintain-resolution`). Low-bandwidth links shed framerate first, then
  resolution — degrading gracefully instead of stalling.
- **No hard ceiling** other than the caller-supplied `maxKbps` (default 40 Mbps);
  the controller never imposes a time-based throttle (the 500 ms tick and the
  4-sample gate are control-loop cadence, never a session limit). The viewer
  additionally surfaces Auto/High/Balanced/Low presets (`viewer/src/quality.ts`).
- **Proven closed-loop e2e.** `e2e/tests/adaptive-closed-loop.spec.ts` brings up a
  *real* two-Chromium WebRTC session, drives the *real* `AdaptiveController` +
  `peer.applyDecision()`, and reads the encodings off the **real `RTCRtpSender`**.
  It proves congestion drops the real sender's bitrate/framerate and raises the
  downscale; that **receiver-side `playoutMs` alone** (wire RTT under target)
  forces a backoff; that a sustained clean link recovers the bitrate above the
  trough; and that the viewer's `{ t:latency }` telemetry round-trips to the host —
  the loop closed against actual WebRTC, not a mock.

---

## The input pipeline

Remote control flows viewer -> host over a reliable, ordered WebRTC **data
channel** (label `input`), separate from the media track.

```mermaid
flowchart LR
  E["DOM mouse/keyboard\n(viewer)"] --> N["normalize to 0..1\n(object-fit aware)\n+ modifier bitflags"]
  N --> ENC["encodeInput()\ncompact JSON, 4-dp coords"]
  ENC --> CH["data channel 'input'\n(DTLS-SRTP)"]
  CH --> DEC["decodeInput()\n(host)"]
  DEC --> MAP["map normalized->pixels,\nbutton enum, key codes,\nmodifier hold/release"]
  MAP --> OS["nut.js OS injection\n(or Electron clipboard\nfor clipboard events)"]
```

- **Resolution independence.** Pointer coordinates are normalized fractions in
  `[0,1]` of the remote screen, so they work regardless of either side's
  resolution. The host maps them to pixels against the live screen size
  (`normalizedToPixels`).
- **Events.** `m-move`, `m-down`, `m-up`, `m-wheel`, `k-down`, `k-up`,
  `clipboard`. Buttons: 0=left, 1=middle, 2=right. Modifier bitflags: 1=shift,
  2=ctrl, 4=alt, 8=meta.
- **Special key combos.** `buildKeyCombo` / `SPECIAL_KEYS` (`core/src/protocol.ts`)
  turn a logical chord (e.g. `['ctrl','alt','delete']`) into an ordered
  key-down/up sequence carrying the cumulative modifier bitmask, so chords the
  browser would intercept — **Ctrl+Alt+Del**, Win, Alt+Tab, Win+R, Win+D, Alt+F4,
  Esc — replay correctly on the host injector. These pure builders are
  unit-tested without the native library.
- **Ctrl+Alt+Del → SAS.** The chord arrives over the input channel as ordinary
  key events, but a synthetic Ctrl+Alt+Del is ignored by the Windows Secure
  Attention Sequence (SAS) on the secure desktop. `HostSession` detects the
  chord's signature (a `Delete` key-down with both Ctrl and Alt held) and routes
  it to the real `SendSAS` API (`input-injector.ts`) instead of replaying the
  keys, suppressing the synthetic Delete replay. Software-initiated SAS requires
  the host's `SoftwareSASGeneration` group policy to be enabled; without it
  `SendSAS` no-ops and the host falls back to the synthetic chord.
- **Wire codec** (`core/input-codec.ts`) is compact JSON with coordinates rounded
  to 4 decimals (sub-pixel on 4K) to keep pointer-move spam small; it is pure and
  round-trip safe, with an exhaustiveness guard so a new event variant fails to
  compile until handled.
- **Key translation.** DOM `KeyboardEvent.code` (e.g. `KeyA`, `Digit1`,
  `ArrowLeft`, `F5`) maps to nut.js `Key` enum names. A modifier pressed on its
  **own** key event (Ctrl/Alt/Shift/Meta, either side) is held down until its own
  key-up — it is never released as a side effect of an unrelated non-modifier
  key-up — so chords like **Ctrl+Tab** cycling or **Shift+Arrow** selection keep
  the modifier physically down across the repeats. A modifier asserted only by a
  non-modifier key's `mods` bitfield (e.g. the AI `press_key key='c' mods=ctrl`
  path, which sends no separate modifier event) is pressed transiently and
  released on that key's key-up, but never releases a modifier that is also
  physically held. The pure mapping is unit-tested without the native library.
- **Graceful degradation.** The native injector (`@nut-tree-fork/nut-js`) is an
  **optional** dependency loaded lazily. If absent, input becomes a logged no-op
  and streaming continues. Clipboard events are handled by the Electron clipboard
  in the main process rather than synthetic keystrokes.

---

## Session features over the control & file channels

Collaboration features beyond raw screen+input ride two additional WebRTC data
channels next to the video/audio media — both reliable and ordered, both fully
peer-to-peer (they never traverse the signaling server):

- a text `control` channel carrying JSON `ControlMessage`s, and
- a binary `file` channel carrying raw file bytes.

The `ControlMessage` union (`core/src/protocol.ts`) is a single discriminated
type with a strict runtime guard (`isControlMessage`) that validates each
variant's required fields, so a malformed frame is rejected rather than partially
trusted. Its variants:

| Variant(s) | Purpose |
|---|---|
| `chat` | timestamped text chat, either direction |
| `request-monitors`, `monitors`, `switch-monitor`, `monitor-switched` | multi-monitor enumeration + runtime switch |
| `file-offer`, `file-accept`, `file-reject`, `file-progress`, `file-complete`, `file-error` | file-transfer signaling for the binary `file` channel |
| `audio` | toggle host system-audio capture on/off |
| `quality` | select an `auto`/`high`/`balanced`/`low` preset |
| `latency` | viewer → host end-to-end interactive-latency telemetry (`rttMs`, `playoutMs`, optional `fps`) folded into the adaptive loop |

```mermaid
flowchart LR
  subgraph V["VIEWER"]
    VC["control sender"]
    VF["FileTransferManager"]
    REC["MediaRecorder -> .webm"]
    MUTE["audio mute toggle"]
  end
  subgraph H["HOST"]
    HC["control router"]
    SWAP["replaceTrack\n(monitor switch)"]
    SAVE["file-save (disk)"]
    AUD["system-audio capture"]
  end
  VC <-->|"control channel (JSON): chat, monitors,\naudio, quality, file signaling"| HC
  VF ==>|"file channel (binary, framed chunks)"| SAVE
  HC --> SWAP
  HC --> AUD
  VS2["remote MediaStream\n(video + audio)"] --> REC
  VS2 --> MUTE
```

- **System audio.** The host mixes desktop audio into the captured stream and
  negotiates it as an audio track on the *same* peer connection (no second
  connection). The viewer plays it inline; mute/unmute flips the inbound track's
  `enabled` flag, and an `audio` control message asks the host to start/stop
  capture.
- **Multi-monitor switching.** The host advertises its displays as `MonitorInfo`
  (`id, name, primary, width, height`). The viewer requests the list, picks a
  display, and the host swaps the outbound video track **in place**
  (`replaceTrack`) — no SDP renegotiation, no session teardown — then acks
  `monitor-switched`. Only the *previous* tracks are stopped; the newly swapped-in
  track is kept live, so the viewer sees the new monitor instead of a frozen
  frame. The **host operator's own capture-source switch** (the control-window
  dropdown) uses this very same in-place path (`HostSession.switchSource` →
  `switchMonitor` → `replaceVideoTrack`): it re-captures the chosen source and
  swaps the outbound track **without leaving and rejoining the signaling room**.
  The earlier renderer stopped the session and immediately created a new one with
  the same code, but `stop()` returns before the server observes the host's
  departure, so the fresh join could race ahead and be rejected as `host-exists`
  — leaving the operator with no advertised session after a source change. Staying
  joined in place removes the race entirely.
- **File transfer.** `FileTransferManager` (`core/src/file-transfer.ts`) is a
  pure, DOM-free chunker/reassembler. The sender emits `file-offer`, awaits
  `file-accept`, streams 16 KiB chunks over the binary `file` channel, then
  `file-complete`. Each chunk carries its **own transfer id** (a uint16
  length-prefixed id ahead of the `seq`+`payloadLen` header), so several
  concurrent transfers can share the single binary channel: the receiver routes
  every frame to its transfer by id, which keeps overlapping transfers (the
  viewer picker allows selecting multiple files) from corrupting one another. The
  receiver reassembles deterministically (the seq lets it slot out-of-order
  frames and detect gaps/duplicates) and reports `file-progress`; the Windows host
  persists received files via `host/src/file-save.ts`.
- **Recording.** Purely viewer-side and local: a `MediaRecorder` over the
  incoming remote `MediaStream` yields a downloadable `.webm`. Nothing is uploaded
  and there is no length cap.
- **Chat & quality.** Chat is timestamped text either direction; `quality` lets a
  viewer (or AI agent) pin a preset that the host actually honors: a
  `{t:'quality',preset}` control message re-bounds the `AdaptiveController` to the
  preset's `maxKbps` ceiling (`high`/`balanced`/`low` step it progressively down),
  so the AIMD loop can never ramp the stream above the chosen ceiling. `auto`
  restores the full adaptive range. This only uses the public controller bounds —
  nothing in `@stream-screen/core` changes, and there is no timer or usage cap.

None of these features introduce a timer, a usage counter, or a cap — they obey
the [No-limits guarantee](#no-limits-guarantee) like the rest of the system.

---

## AI control layer (MCP + REST)

`@stream-screen/ai` lets an AI agent (or any automation) drive a session as a
*viewer*. One shared tool registry (`tools.ts`) generates **both** an MCP stdio
server and a mirrored Express REST API, so the two transports can never diverge.

```mermaid
flowchart LR
  AG["AI agent / script"] -->|MCP stdio| MCP["mcp-server.ts"]
  AG -->|HTTP| RA["rest-api.ts"]
  MCP --> RDS["RemoteDesktopSession"]
  RA --> RDS
  RDS -->|viewer Peer| CORE["@stream-screen/core"]
  CORE -.->|WebRTC P2P| HOST["remote host"]
  RDS --> OCR["tesseract.js (optional)"]
  RDS --> WRTC["@roamhq/wrtc (optional)"]
```

Tools: `list_hosts`, `connect`, `disconnect`, `screenshot`, `ocr_screen`,
`move_mouse`, `click`, `type_text`, `press_key`, `get_stats`, plus the
session-feature tools `list_monitors`, `switch_monitor`, `send_chat`,
`set_quality`, `send_keys` (arbitrary chord), and `press_combo` (named combos
incl. Ctrl+Alt+Del) — every one generated from the same `tools.ts` registry that
drives the MCP and REST surfaces, so they cannot drift. `list_hosts` is backed by
the signaling server's **REST API over HTTP** (`GET /api/discover`, falling back
to `/api/sessions`; the HTTP base is derived from the signaling WS URL or set via
`STREAMSCREEN_SIGNALING_HTTP_URL`), since the WS server has no `hosts` request —
so every code it returns maps to a live, joinable room. Returned codes are
validated against the 6–9 digit pattern and any unusable one is dropped; in
particular the `/api/sessions` fallback redacts codes (e.g. `****56`) for
unauthenticated callers, so `list_hosts` presents `STREAMSCREEN_TOKEN` as a bearer
token for un-redacted codes and drops any redacted code that `connect` would
reject. When `/api/discover` advertises a host's own `address`/`port`,
`list_hosts` carries that host's signaling endpoint
(`ws://address:port`, IPv6 bracketed) through with the code, so a later
`connect(code)` joins against **that** host's own signaling server rather than
this AI server's configured `signalingUrl` — a host on another LAN machine is
reachable instead of failing with `no-such-session`. A manually-entered
(undiscovered) code, or an explicit `signalingUrl` argument to `connect`,
overrides this and uses the given/configured endpoint. The node WebRTC
runtime and OCR engine are optional dynamic imports; when missing, the server and
its schemas stay valid and only the affected calls return a clear error.
Screenshots are produced by converting raw I420 frames to PNG with a
dependency-free encoder. **No call counts usage or expires a session.**

---

## Security model

StreamScreen is **LAN-first** and trades WAN reach for simplicity and privacy.

- **Transport encryption.** All WebRTC media and data are **DTLS-SRTP** encrypted
  end-to-end by the browser/Electron WebRTC stack. Even on the LAN, media and
  input are never sent in the clear.
- **No relay, no cloud.** Media and input flow directly peer-to-peer. The
  signaling server sees only SDP/ICE and room membership; it never sees pixels or
  keystrokes. There is no third-party server in the data path.
- **Session gating.** A session is gated by a **6–9 digit numeric code**. Viewers
  must target an existing room; unknown codes are rejected (`no-such-session`).
  Codes are minted with platform crypto where available.
- **Identity within a room.** The server assigns each peer an authoritative id
  and overwrites the `from` field on every relayed message, so peers in a room
  cannot impersonate one another during signaling.
- **Least privilege on the host.** The Electron host control window runs with
  `sandbox: true`, `contextIsolation`, no `nodeIntegration` in the renderer, a
  preload contextBridge for IPC, and a single-instance lock. OS input injection
  is an *optional* capability.
- **CORS.** The REST surfaces use permissive CORS deliberately, because they are
  intended to be reached from the LAN viewer/automation on other origins. Run the
  signaling and AI servers on trusted networks.
- **WS Origin policy.** The signaling WebSocket handshake checks the browser
  `Origin`. Non-browser clients (no Origin) and an explicit
  `STREAMSCREEN_ALLOWED_ORIGINS` allowlist (or `*`) are honored first; otherwise
  the default LAN/dev policy accepts Origins whose host is loopback, the same host
  as the server (any port — so the Vite dev viewer on `:5173` reaches signaling on
  `:8787`), or a private/link-local LAN address, and rejects foreign public
  origins. Bracketed IPv6 literals in the `Origin` are unwrapped before the LAN
  check — `[::1]` (loopback), `[fd00::…]` (ULA), and `[fe80::…%zone]`
  (link-local, including a zone-id that makes `new URL().hostname` throw) are
  recognised rather than rejected. This keeps the zero-config and documented
  dev-viewer flows working without configuration while blocking cross-site
  public pages.
- **Threat model & limits.** The code gates *access*, but a short numeric code is
  not a substitute for network-level isolation on hostile networks. There is no
  built-in authentication beyond the code and no audit log. For untrusted
  networks, place StreamScreen behind a VPN/firewall (WAN/VPN traversal is on the
  roadmap; STUN/TURN hooks already exist in `Peer`).

---

## No-limits guarantee

This is load-bearing for StreamScreen's "always free, unlimited time" promise and
is enforced in code, not just by default config:

- **No session timer.** Nowhere in the signaling server, host, viewer, or AI
  layer is there a timer that ends or throttles a *healthy* session. A session
  lives exactly as long as its sockets stay open. (Contrast: AnyDesk's free tier
  ~15‑minute cutoff.)
- **The only timers are safety mechanisms, not limits.** The signaling
  heartbeat reaps *dead* sockets; the adaptive loop samples stats every ~500 ms
  (control-loop cadence, plus a 4-sample slow-up gate that is a deterministic
  counter, not wall-clock); `SignalingClient` backoff reconnects; the host's
  join-ack timeout
  (`JOIN_ACK_TIMEOUT_MS`) bounds only the connect-time wait for the server's
  `joined` reply. None of these end a live session.
- **No usage metering or licensing.** No counters, no "commercial use" checks, no
  watermarks, no viewer caps imposed by policy.
- **No bitrate cap.** The only ceiling is the caller-supplied `maxKbps` (default
  40 Mbps) and what the physical link sustains — the adaptive engine raises
  quality whenever the link allows.
- **Rooms disappear only when the host leaves or the room empties.** A room is
  reaped once the host disconnects (it is no longer joinable) or the last socket
  leaves — this is cleanup, not a timeout.
- **Every feature is unmetered.** Audio, file transfer, multi-monitor switching,
  session recording, chat, and special key combos all run for the full life of
  the session with no per-feature timer, byte counter, or paywall — unlike
  AnyDesk, which gates file transfer/recording behind paid tiers and the
  ~15-minute free cutoff.

These invariants are documented at their enforcement points in
`signaling/src/server.ts`, `host/src/host-session.ts`, `core/src/adaptive.ts`,
and `ai/src/session.ts`.
</content>
