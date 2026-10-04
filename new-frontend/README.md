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

Copy `.env.example` to `.env.local` to override it locally.

## Layout

- `src/pages/Landing.tsx` camera preview, profile setup (photo, name, gender, topics), then the room.
- `src/pages/Room.tsx` the call screen, built from `src/components/room/*`.
- `src/hooks/useSignaling.ts` typed socket and the matchmaking state machine.
- `src/hooks/usePeerConnection.ts` and `src/lib/peerSession.ts` one RTCPeerConnection per call.
- `src/hooks/useMediaStream.ts` camera and microphone, with errors explained by cause.
- `src/lib/photo.ts` downscales the profile photo to a small JPEG within protocol limits.
- `src/components/ui/*` vendored shadcn/ui components, kept as generated.
