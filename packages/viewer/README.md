# @stream-screen/viewer

The StreamScreen web viewer — a Vite + React + TypeScript app that runs in any
modern browser. It connects to a host peer-to-peer over WebRTC, renders the
remote screen, captures mouse/keyboard input, and shows a live adaptive-stats
dashboard. This is also the AI-friendly surface (the `@stream-screen/ai` package
drives the same primitives).

**Always free. Unlimited time. No bitrate caps. No accounts.** A session is
gated only by a 6–9 digit code; media is DTLS-SRTP encrypted by the WebRTC stack.

## Run

```bash
npm run dev        # vite dev server (proxies /api/* to the signaling server)
npm run build      # production build
npm run preview    # preview the build
npm run test       # vitest unit tests (jsdom)
npm run typecheck  # tsc --noEmit
```

By default the dev server proxies `/api` and `/health` to
`http://localhost:8787` (the signaling server). Override with
`VITE_SIGNALING_HTTP`. The viewer derives its WebSocket signaling URL from the
page host on port `8787` (see `defaultSignalingUrl`).

## Layout

- `src/viewer-session.ts` — `ViewerSession`: signaling + `Peer` (role `viewer`),
  receives the remote track, polls `AdaptiveStats`, relays `InputEvent`s.
- `src/input-capture.ts` — mouse/keyboard capture, 0..1 coordinate
  normalization (object-fit: contain aware), modifier bitflags, ~120Hz move
  throttle, pointer lock, fullscreen, clipboard sync.
- `src/discovery-client.ts` — `/api/discover` (mDNS LAN hosts) + `/api/code`.
- `src/quality.ts` — Auto/High/Balanced/Low presets over the core
  `AdaptiveController` (used to surface the live decision reason).
- `src/components/` — `ConnectScreen`, `VideoStage`, `Toolbar`, `StatsPanel`,
  `DiscoveryList`.
- `src/App.tsx`, `src/main.tsx`, `index.html` — wiring + mount.

All protocol types and runtime building blocks come from `@stream-screen/core`.
