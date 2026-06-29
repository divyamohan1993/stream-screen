# Contributing to StreamScreen

Thanks for your interest in StreamScreen — a free, unlimited-time, LAN-first
peer-to-peer remote desktop for Windows over WebRTC. Contributions of all kinds
are welcome: bug reports, features, docs, and tests.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Project layout

This is an npm-workspaces monorepo (TypeScript):

| Package | Path | What it is |
|---|---|---|
| `@stream-screen/core` | `packages/core` | Shared protocol types, WebRTC peer wrapper, adaptive engine, input codec. Pure TS (browser + node). |
| `@stream-screen/signaling` | `packages/signaling` | Zero-config LAN signaling server (WS SDP/ICE relay, mDNS discovery, REST health/list). |
| `@stream-screen/host` | `packages/host` | Electron host agent for Windows (screen capture + remote input injection). |
| `@stream-screen/viewer` | `packages/viewer` | Web viewer (React + Vite): remote screen, input capture, live stats. |
| `@stream-screen/ai` | `packages/ai` | AI control layer: MCP (stdio) server + mirrored REST API. |
| `@stream-screen/e2e` | `e2e` | Playwright end-to-end tests (two real Chromium peers over the signaling server). |

## Prerequisites

- Node.js >= 20
- npm (the repo uses npm workspaces and a committed `package-lock.json`)

Some dependencies are **optional** and dynamically imported, so the repo builds
and tests fine without them:

- `@nut-tree-fork/nut-js` (host native input injection)
- `@roamhq/wrtc` (Node-side WebRTC for the AI layer)
- `tesseract.js` (OCR for the AI layer)

The Electron binary is not needed for building/testing. You can skip its
download with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when running `npm ci`/`npm install`.

## Getting started

```bash
git clone https://github.com/divyamohan1993/stream-screen.git
cd stream-screen
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

## Build

```bash
npm run build        # tsc project references + viewer typecheck
```

## Test

```bash
# Unit tests (Vitest) across every workspace:
npm run test --workspaces --if-present

# Or a single package:
npm -w @stream-screen/core test

# End-to-end (Playwright, two real Chromium peers):
npm run e2e

# Everything (build + unit + e2e):
npm run verify
```

The Playwright config (`e2e/playwright.config.ts`) auto-detects its browser:
when `/opt/pw-browsers` exists it uses that pre-installed Chromium; otherwise it
falls back to Playwright's default-installed browser (run
`npx playwright install --with-deps chromium` once in that case).

## Running locally

```bash
# 1. Signaling server (zero-config LAN)
npm run dev:signaling

# 2. Web viewer (dev server)
npm -w @stream-screen/viewer run dev

# 3. Electron host (Windows) — needs the Electron binary installed
npm -w @stream-screen/host start
```

See [README.md](./README.md) for full run instructions and the configuration
reference.

## Building the Windows host (.exe)

```bash
npm -w @stream-screen/host run build
npm -w @stream-screen/host run dist   # electron-builder --win (nsis + portable)
```

Artifacts land in `packages/host/release/`. Build these on Windows (or a Windows
CI runner) for native-module compatibility. The tagged release workflow
(`.github/workflows/release.yml`) does this automatically on `v*` tags.

## Coding guidelines

- TypeScript everywhere; keep `npm run build` clean (no type errors).
- Add or update tests for behavior changes. **Do not weaken existing assertions.**
- **Never introduce a session time limit, usage cap, or bitrate ceiling.**
  The no-limits guarantee is part of the product and is enforced in code and
  tests (see [ARCHITECTURE.md](./ARCHITECTURE.md#no-limits-guarantee)).
- Keep optional native deps optional — guard them behind dynamic imports.

## Pull requests

1. Fork and create a feature branch.
2. Make your change with tests.
3. Run `npm run build`, the unit tests, and `npm run e2e` locally.
4. Open a PR against `main` and fill out the PR template. CI must be green.

## Reporting security issues

Please **do not** open a public issue for security problems. See
[SECURITY.md](./SECURITY.md) for how to report responsibly.
