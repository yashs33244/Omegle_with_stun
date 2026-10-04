# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting (Security tab -> "Report a vulnerability") on this repository, with
steps to reproduce and the impact you see. You should get a reply within a few
days. Only the latest deployed version (the `new-v` branch) is supported.

## Security model in short

- **Anonymous by design.** There are no accounts. A random device id in the
  browser identifies a user for coins, friends, blocks and bans, so those are
  best-effort: clearing site data gives a fresh identity.
- **Untrusted clients.** Every socket payload is validated against the zod
  schemas in `backend/src/protocol.ts` with strict size limits; profile photos
  must be small `data:image/...` URLs (no remote URLs, so a photo cannot be used
  as a tracking beacon). Signaling and chat are relayed only between the two
  members of a call both sides accepted, and reports are accepted only from a
  member of the reported room. Events are rate limited per socket and
  connections are capped per IP.
- **Media is peer to peer.** Audio and video go directly between browsers
  (DTLS-SRTP), or through the optional TURN relay, which cannot read them and
  refuses to relay to private, loopback and link-local addresses.
- **What a partner learns.** The name, topics, language and optional photo you
  entered. WebRTC also reveals your IP address to the partner unless a TURN
  relay is forced; this is inherent to peer-to-peer calls.
- **Data kept on the server (Redis):** coin balances, friend pairs, temporary
  pair blocks, reports (reason, details, device ids, time; capped at 10,000)
  and temporary bans. No chat text, photos or media are stored. Logs carry
  socket ids, room ids and event names, never names, photos or chat text.
- **Web hardening.** The frontend is served with a strict Content Security
  Policy (`script-src 'self'`, `connect-src` limited to the API origin),
  `Permissions-Policy` allowing camera and microphone only for the site itself,
  `X-Frame-Options: DENY` and `nosniff`. Containers run as non-root users,
  Redis is reachable only on the internal Docker network, `/metrics` is not
  exposed publicly, and CORS is restricted to `CORS_ORIGINS` in production.
- **Supply chain.** Workflow actions are pinned to commit SHAs, base images to
  exact versions, dependencies to lockfiles, and Dependabot proposes updates.
  Only the deploy workflow uses the deploy secrets, and pull requests from
  forks never receive them.

## Known limitations

- Bans and reports can be evaded by resetting the device id.
- There is no automated content moderation.
- Users who need IP privacy from their partner need a forced TURN relay, which
  the app does not offer as a setting.
