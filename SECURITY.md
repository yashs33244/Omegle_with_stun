# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting (Security tab -> "Report a vulnerability") on this repository, with
steps to reproduce and the impact you see. You should get a reply within a few
days. Only the latest deployed version (the `new-v` branch) is supported.

Safety reports about content or users (not software bugs) go through the
in-app report button or the takedown form, not here.

## Security model in short

- **Anonymous by design, gated.** There are no accounts. A random device id
  in the browser, a Cloudflare Turnstile check and a signed, short-lived
  session token (from `POST /api/session`, required at the socket handshake)
  identify a session. The date of birth is used to compute 18+ and is not
  stored. Restrictions are keyed on the device id, a salted fingerprint hash
  and IP ranges, so they are best-effort: a new browser or device gets a
  fresh identity.
- **Untrusted clients.** Every socket payload and REST body is validated
  against the zod schemas in `backend/src/protocol.ts` with strict size
  limits; profile photos must be small `data:image/...` URLs (no remote URLs,
  so a photo cannot be used as a tracking beacon). Signaling and chat are
  relayed only between the two members of an active call. Events are rate
  limited per socket, connections are capped per IP, and the gateway caps
  REST bodies at 64 KB.
- **Report evidence is attacker-controlled.** A reporter's client captures
  the frame and chat lines, so the server treats evidence as unverified: it
  never triggers an automatic penalty on its own, report-driven automatic
  actions stop at a temporary pause, and suspected CSAM goes to a restricted
  store the console never displays.
- **Media is peer to peer.** Audio and video go directly between browsers
  (DTLS-SRTP), or through Cloudflare's TURN relay, which cannot read them.
  TURN credentials are issued only per matched call with a short lifetime.
- **What a partner learns.** The name, topics, language and optional photo you
  entered. In the default peer-to-peer mode WebRTC also reveals your IP
  address to the partner; "Hide my IP" forces the relay to prevent that.
- **Client IP and country.** The gateway trusts `X-Forwarded-For` only from
  private addresses (the host proxy), and `CF-Connecting-IP` / `CF-IPCountry`
  only when the previous hop is a published Cloudflare range; otherwise it
  drops them. With `CLOUDFLARE_ONLY=true` it refuses public traffic that did
  not come through Cloudflare (DEPLOYMENT.md, "Cloudflare in front").
- **Admin console.** `/admin/api/*` requires `Authorization: Bearer
  ADMIN_TOKEN` (off when unset), optionally an IP allowlist
  (`ADMIN_ALLOWED_IPS`), and should sit behind Cloudflare Access. Every admin
  action and every evidence access is written to an audit log. Responses are
  `Cache-Control: no-store`. Evidence is shown blurred and greyscale by
  default.
- **Data kept on the server.** See docs/retention.md. No chat text (except
  lines attached to a report), no video or audio, no dates of birth. Logs
  carry socket ids, room ids and event names, never names, photos or chat
  text. Sentry events are scrubbed of names, chat, photos and evidence;
  PostHog runs cookieless with IP capture off.
- **Web hardening.** The frontend's Content Security Policy allows scripts
  only from the site itself and Cloudflare Turnstile, `wasm-unsafe-eval` for
  the self-hosted moderation models, network calls only to the API origin,
  Turnstile, Sentry ingest and PostHog, and frames only from Turnstile.
  `Permissions-Policy` allows camera and microphone for the site itself
  only; `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy`.
  Containers run as non-root users, Redis is reachable only on the internal
  Docker network, `/metrics` is not exposed publicly, and CORS is restricted
  to `CORS_ORIGINS` in production.
- **Secrets.** All secrets live in GitHub Actions secrets and are written to
  the host's `.env` (mode 600) without being printed. `SESSION_SECRET` can be
  rotated with `SESSION_SECRET_PREVIOUS`.
- **Supply chain.** Workflow actions are pinned to commit SHAs, base images to
  exact versions, dependencies to lockfiles that may only reference the public
  npm registry, and Dependabot proposes updates. CI runs actionlint and
  shellcheck. Only the deploy workflow uses the deploy secrets, and pull
  requests from forks never receive them.

## Known limitations

- Restrictions can be evaded with a new device or by clearing site data.
- Age is self-declared; there is no age estimation or verification in v1.
- Video moderation runs on the users' devices; a modified client can switch
  off its own checks. There is no server-side frame sampling.
- The partner sees your IP address unless "Hide my IP" is on.
- Logs are not yet retained for 180 days in an India-region store.
