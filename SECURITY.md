# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting (Security tab -> "Report a vulnerability") on this repository, with
steps to reproduce and the impact you see. You should get a reply within a few
days. Only the latest deployed version (the `main` branch) is supported.

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
  ADMIN_TOKEN` (32+ characters, required in production; off when unset
  elsewhere), optionally an IP/CIDR allowlist (`ADMIN_ALLOWED_IPS`), and
  should sit behind Cloudflare Access. Bad tokens are limited per address
  (IPv4 address, IPv6 /64) and instance-wide: once 100 fail in an hour,
  every address that failed is locked out for the rest of the hour while
  clean addresses are still judged by the token. Every admin
  action and every evidence access is written to an audit log. Responses are
  `Cache-Control: no-store`. Evidence is shown blurred and greyscale by
  default. Admins see device pseudonyms keyed by `PSEUDONYM_SALT`, not raw
  device ids.
- **Data kept on the server.** See docs/retention.md. No chat text (except
  lines attached to a report), no video or audio, no dates of birth. Logs
  carry socket ids, room ids and event names, never names, photos or chat
  text. Sentry events are scrubbed of names, chat, photos and evidence;
  PostHog runs cookieless with IP capture off.
- **Availability.** Every limit that keeps one client from degrading the
  service for others is listed with its source in docs/LIMITS.md: per-IP
  connection caps and connect rate enforced on the WebSocket upgrade before
  any state exists, a hello deadline for idle sockets, per-connection packet
  and byte budgets ahead of JSON parsing, per-event buckets, bounded Node
  http timeouts (15 s headers, 30 s request, 65 s keep-alive), body caps
  checked against `Content-Length` before a byte is read, a cap on Turnstile
  verifications in flight, a renewed and fenced Redis match lock, and
  gateway `limit_req`/`limit_conn` zones plus slow-client timeouts in the
  compose stack. Memory-store collections are bounded or swept.
- **Money.** A Razorpay order is credited exactly once per order id (not per
  payment id), the credit claim survives partial write failures, unpaid
  orders expire after a day, and a fresh device id starts with no coins so
  the paid gender filter cannot be unlocked by churning identities.
- **Web hardening.** The frontend's Content Security Policy allows scripts
  only from the site itself and Cloudflare Turnstile, `wasm-unsafe-eval` for
  the self-hosted moderation models, network calls only to the API origin,
  Turnstile, Sentry ingest and PostHog, and frames only from Turnstile.
  `Permissions-Policy` allows camera and microphone for the site itself
  only; `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy`,
  HSTS. "Hide my IP" fails closed: when the relay is unavailable no
  connection is created until the user explicitly continues or skips.
  Containers run as non-root with all capabilities dropped, a read-only
  root filesystem and memory/pid limits; Redis is reachable only from the
  backend's Docker network, `/metrics` needs `METRICS_TOKEN`, and CORS is
  restricted to `CORS_ORIGINS` in production.
- **Secrets.** All secrets live in GitHub Actions secrets and are written to
  the host's `.env` (mode 600) without being printed. In production the
  backend refuses to start without `SESSION_SECRET`, `ADMIN_TOKEN` and the
  Turnstile keys, and the deploy stops before touching the host when one is
  missing. `SESSION_SECRET` can be rotated with `SESSION_SECRET_PREVIOUS`.
- **Supply chain.** Workflow actions are pinned to commit SHAs, base images to
  exact versions, dependencies to lockfiles that may only reference the public
  npm registry, and Dependabot proposes minor and patch updates (majors are
  taken deliberately). CI runs actionlint, shellcheck and zizmor; checkouts do
  not persist credentials, published builds never come from a shared cache,
  and image pushes and releases run in protected environments. Pull requests
  from forks never receive secrets. Secret scanning with push protection and
  private vulnerability reporting are enabled on the repository.

## Known limitations

- Restrictions can be evaded with a new device or by clearing site data.
- Age is self-declared; there is no age estimation or verification in v1.
- Video moderation runs on the users' devices; a modified client can switch
  off its own checks. There is no server-side frame sampling.
- The partner sees your IP address unless "Hide my IP" is on.
- Logs are not yet retained for 180 days in an India-region store.
