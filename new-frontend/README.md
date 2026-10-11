# Chizzy frontend

React 18 + Vite + TypeScript single-page app for Chizzy video chat. It talks to
the backend over Socket.IO (websocket transport) and connects calls with WebRTC.
The socket protocol lives in `src/lib/protocol.ts`, a copy of
`backend/src/protocol.ts`; never edit the copy, run `scripts/sync-protocol.sh`.

npm is the package manager for this folder (`package-lock.json`).

## Scripts

| command | what it does |
|---|---|
| `npm ci` | install exactly what the lockfile pins |
| `npm run dev` | dev server on http://localhost:8080 |
| `npm run typecheck` | `tsc` in strict mode, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit and component tests (jsdom) |
| `npm run build` | production build into `dist/` |

## Configuration

| variable | when | default |
|---|---|---|
| `VITE_API_URL` | build time | `http://localhost:3004` in dev, `https://chizzyapi.itsyash.space` in production builds |
| `VITE_SITE_URL` | build time | `https://chizzy.itsyash.space`; public origin for the canonical and link preview URLs, `sitemap.xml` and `robots.txt` |

Copy `.env.example` to `.env.local` to override it locally.

## End-to-end tests

`npm run test:e2e` runs the Playwright suite in `e2e/`. By default it builds
and starts its own backend and preview servers on these ports:

| variable | default | what it is |
|---|---|---|
| `E2E_API_PORT` | `3104` | backend for the main specs |
| `E2E_WEB_PORT` | `4173` | frontend preview for the main specs |
| `E2E_TIMEOUT_API_PORT` | `E2E_API_PORT` + 1 | backend with a short accept window |
| `E2E_TIMEOUT_WEB_PORT` | `E2E_WEB_PORT` + 1 | frontend preview for that backend |

Set other ports to run beside another e2e run or `npm run preview` (4173), for
example `E2E_API_PORT=4510 E2E_WEB_PORT=4610 npm run test:e2e`. To test a
running stack instead, set `E2E_BASE_URL` (and optionally
`E2E_TIMEOUT_BASE_URL` and `E2E_ACCEPT_TIMEOUT_MS`); no servers are started
then.

## Layout

- `src/pages/Landing.tsx` the start screen: camera tile, profile row, Instant/Preview and Start. The profile editor and the settings sheet are `src/components/landing/*`.
- `src/pages/Room.tsx` the call screen, built from `src/components/room/*`.
- `src/hooks/useSignaling.ts` typed socket and the matchmaking state machine.
- `src/hooks/usePeerConnection.ts` and `src/lib/peerSession.ts` one RTCPeerConnection per call.
- `src/hooks/useMediaStream.ts` camera and microphone, with errors explained by cause.
- `src/lib/photo.ts` downscales the profile photo to a small JPEG within protocol limits.
- `src/components/ui/*` shared surfaces. `BottomSheet` (modal sheet on phones, dialog from `md`), `Segmented` and `StickyBar` are ours and document their props in the file header; `alert-dialog.tsx` is vendored shadcn/ui, kept as generated.
- `src/premium/*` the gender-filter paywall contract (`PremiumProvider`, `useGenderFilterGate`); the stub here is replaced by the billing lane.

## Mobile layout rules

- Tokens live in `src/index.css` (`--tap-min`, `--safe-*`, `--app-height`) and are exposed by Tailwind as `min-h-tap`, `min-w-tap`, `h-app`/`min-h-app`, `pb-safe-bottom` and so on.
- Anything a finger taps is at least 44 x 44 px; one primary action per screen, kept reachable without scrolling (`StickyBar`); forms open in a `BottomSheet` on phones.
- Full-height screens use `min-h-app` (100dvh with a 100vh fallback), never `100vh` alone, and pad with `--safe-*` instead of fixed margins.
