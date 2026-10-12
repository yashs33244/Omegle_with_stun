# Limits: how many users, how long a call, and what breaks first

Companion to [ARCHITECTURE.md](ARCHITECTURE.md) (how the parts fit) and
[PROTOCOL.md](PROTOCOL.md) (every socket event and REST route). This page
answers two questions with evidence from the code, then lists every limit the
system enforces, the weak points, and what is lost when something restarts.

Every number below is quoted from a file in this repository. Where a value was
measured, the measurement is in [capacity.md](capacity.md). Anything that is an
estimate rather than a measurement is marked **estimate**. Base: branch
`main`, commit `472644e`.

## 1. How many users can talk at once?

The backend never carries media. A call is WebRTC between the two browsers
(or through Cloudflare TURN when a direct path fails or "Hide my IP" is on;
`docker-compose.yml` header comment, `backend/src/turn/TurnService.ts`). The
server holds one WebSocket per user and relays small JSON messages: hello,
match events, SDP, ICE candidates, chat, captions
([capacity.md](capacity.md) opening paragraph). So "how many users" is a
question about sockets, the matching loop and the shared store, not bandwidth.

### 1a. Free tier: Render Free + Vercel/Cloudflare Pages, memory store

Topology (`render.yaml`, `new-frontend/vercel.json`): one Render Free web
service runs the backend Docker image with no `REDIS_URL`, so the in-memory
stores are used (`MemoryStore`, `MemoryKv`, `MemoryWalletStore`,
`MemoryEnforcementStore`, `MemoryFlagsStore`). The SPA is static on Vercel
or Cloudflare Pages and talks to `https://chizzy-api.onrender.com`.

| Constraint | Value | Source |
|---|---|---|
| Render Free instance | 0.1 CPU, 512 MB RAM, one instance, ephemeral disk | render.com/docs/free (the facts `render.yaml` works around are listed in its header comment: spin-down, ephemeral filesystem, single instance) |
| Spin-down | after 15 min without inbound traffic, about 1 min to come back | `render.yaml` header, `backend/src/keepalive.ts` header |
| Free instance hours | 750 h/month; one always-on service uses about 744 | `render.yaml` header |
| Self keep-alive | GET own `/healthz` every 10 min (`KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000`) plus the `*/10 * * * *` GitHub cron | `backend/src/keepalive.ts:14`, `.github/workflows/keepalive.yml` |
| Connections per IP | `MAX_CONNECTIONS_PER_IP` default 10 | `backend/src/config.ts:34` |
| Session creation | `SESSION_RATE_PER_IP_PER_MIN` 10, `SESSION_RATE_PER_NETWORK_PER_MIN` 60 (per /24, or /48 for IPv6) | `backend/src/config.ts:54-55`, `docker-compose.yml` comment |
| Matches per hour | `MATCH_CAP_PER_DEVICE_PER_HOUR` 200, `MATCH_CAP_PER_IP_PER_HOUR` 200 | `backend/src/config.ts:56-57` |
| Queue size | flag `max_waiting` default 5,000; over it hello is refused with `matching_closed` | `backend/src/protocol.ts:666`, `backend/src/session/queueGate.ts:44-45` |
| Measured single process | 1,000 sockets, 68 new calls/s, about 15% of one Apple M3 Pro core, 151 MB peak RSS, 0 errors (run C); with 30 s calls, about 7% of a core, 100 MB RSS, every median under 20 ms (run D) | [capacity.md](capacity.md) "Results: 2026-10-04" |

Reading the measurement against the Render Free allowance:

- Memory is not the limit. 1,000 sockets peaked at 151 MB RSS on a
  machine with a 11-core CPU and plenty of headroom; the 512 MB allowance
  leaves room for several thousand sockets of state.
- CPU is the limit. The measured process used 7 to 15% of one M3 Pro core
  at 1,000 sockets. Render Free gives 0.1 of a shared cloud vCPU, which is a
  much smaller unit than 15% of an M3 Pro core. **Estimate:** a few hundred
  concurrent sockets (roughly 200 to 500, i.e. 100 to 250 simultaneous
  calls) before event-loop lag makes `match:found` and signalling visibly
  slow. This has not been measured on Render; the 2026-10-04 runs were on a
  laptop with the memory store, which is the same code path.
- The practical ceiling on the free tier is usually not users at all but
  the platform: a redeploy (every push to `main`,
  `autoDeployTrigger: commit`) or a spin-down restarts the process and the
  memory store with it, dropping every socket, session, room and ban
  (section 4). The keep-alive pair only reduces how often a spin-down
  happens; GitHub cron is best-effort (`keepalive.yml` comment).

### 1b. Full stack: Docker Compose on one host, 2 replicas + Redis + gateway

Topology (`docker-compose.yml`): `redis` (append-only), `backend` x
`BACKEND_REPLICAS` (default 2), `gateway` (nginx `least_conn`, websocket
transport only so no stickiness; `deploy/nginx/gateway.conf:31`), `frontend`
(nginx static). Cloudflare proxies both hostnames.

| Constraint | Value | Source |
|---|---|---|
| gateway `worker_connections` | 16384 per worker, `worker_processes auto`; each proxied websocket uses two connections, so about 8,000 sockets per worker | `deploy/nginx/nginx.conf:5-6,10,17` |
| nofile | 65535 for backend, gateway, frontend containers; `worker_rlimit_nofile 65535` | `docker-compose.yml` `ulimits`, `deploy/nginx/nginx.conf:11` |
| Websocket idle | `proxy_read_timeout 5m` on `/socket.io/`; Socket.IO pings every 20 s (`pingInterval: 20_000`, `pingTimeout: 20_000`) | `deploy/nginx/gateway.conf` `/socket.io/`, `backend/src/realtime/socket.ts:133-134` |
| Gateway per-client rate limits (429 past them; health checks and the compose network are exempt) | `/socket.io/` handshakes 5/s burst 20; `POST /api/session` 1/s burst 20; other `/api/` and health 20/s burst 40; `/admin/api/` 5/s burst 10; open connections per client 32 (`/admin/api/` 16). All above the backend's own per-IP limits, so the backend still decides for normal traffic | `deploy/nginx/gateway.conf` `limit_req_zone`, `limit_conn_zone` |
| Slow clients | request headers and body must arrive within 10 s (`client_header_timeout`, `client_body_timeout`), 30 s between two writes of a response (`send_timeout`); REST bodies 64 KB. The frontend container has the same timeouts | `deploy/nginx/nginx.conf`, `deploy/nginx/gateway.conf` `client_max_body_size`, `new-frontend/nginx-main.conf:42-49` |
| Frontend per-client connections | 32 open connections per client address (keyed like the gateway: X-Forwarded-For from private hops, then CF-Connecting-IP from a Cloudflare edge; the image alone, without the compose mount of `deploy/nginx`, keys on the edge address); 429 past it; health checks exempt | `new-frontend/nginx.conf:5-54`, `docker-compose.yml` `frontend.volumes` |
| Container limits | memory: backend 768 MB per replica, redis 512 MB, gateway 256 MB, frontend 128 MB; pids: 512 / 128 / 256 / 256. A container over its limit is killed and restarted | `docker-compose.yml` `deploy.resources.limits` |
| Replica loss detection | heartbeat every 5 s (`heartbeatIntervalMs: 5_000`); sessions of an instance silent for 15 s (`instanceTtlMs: 15_000`) are removed by the others and their partners get `partner-unavailable` | `backend/src/config.ts:382-383`, `backend/src/match/MatchService.ts:733-745` |
| Match lock | one Redis lock for the whole queue: `LOCK_TTL_MS 3_000`, `LOCK_WAIT_MS 10_000`, backoff 4 to 50 ms | `backend/src/store/constants.ts:28-33` |
| Redis command budget | connect and command timeouts 5 s, 2 retries per request | `backend/src/store/constants.ts:21-25` |
| Measured single process | 200 users: 6% of a core, 98 MB, match p99 762 ms on a saturated machine (run A). 1,000 users: see 1a | [capacity.md](capacity.md) |
| Written expected peak | 1,000 concurrent sockets; the 3,000-socket, 2-hour soak on the staging stack has not been run | [capacity.md](capacity.md) "LB-12" and "Still to do" |

The 200-user and 1,000-user figures are from a single process with the
memory store. Nothing has yet measured the gateway, the Redis store, the
`lock:match` global lock or two replicas together
([capacity.md](capacity.md) "Reading the numbers", last bullet). What the
code says about where it would stop:

- **Redis global lock is the ceiling.** Every hello, accept, skip,
  disconnect and the 500 ms sweeper pass (`sweepIntervalMs: 500`,
  `backend/src/config.ts:379`) on every replica serialise through
  `store.withLock()`. Adding replicas adds sockets and signalling capacity
  but not matching throughput; once lock hold time approaches the 3 s lease
  the store logs an error and callers queue up to 10 s, after which hello and
  skip fail with `internal`. **Estimate:** two replicas comfortably carry
  the written 1,000-socket peak (each replica measured 1,000 alone) and
  likely 2,000 to 3,000 sockets; beyond that, match latency rather than
  socket count degrades first. The LB-12 3,000-socket test is the exit
  criterion for that claim.
- **Per host, the gateway is sized for about 8,000 sockets per nginx worker**
  and the nofile limits for 65,535 descriptors per container, well above
  the backend's expected range.
- **TURN cost, not capacity, caps relayed calls.** The spend poller reads
  Cloudflare egress every 15 min (`turnSpendPollMs: 15 * 60_000`) and at
  35 / 50 / 70 GB per UTC day (`TURN_SPEND_DAILY_GB` default `"35,50,70"`)
  lowers relay video to 300 kbps (`RELAY_STEP_DOWN_KBPS`), switches off
  Hide my IP, then switches TURN off entirely (STUN only)
  (`backend/src/match/matchConfig.ts:26,108`, `backend/src/turn/constants.ts:67`,
  `backend/src/turn/spendPoller.ts:4-11`). Steps never undo themselves.
  When the analytics query fails 4 polls in a row (1 h,
  `SPEND_FAILSAFE_AFTER_FAILURES`, `backend/src/turn/constants.ts:74-80`) the
  spend is unknown and the poller applies steps 1 and 2 blind on every
  failed poll until one succeeds (TURN stays on); the streak is shared
  through Redis key `chizzy:turn-spend:failures`.

### Per-user caps that apply in both topologies

Whatever the topology, one person or one network can never take more than:

- 10 sockets per IP per backend instance (`MAX_CONNECTIONS_PER_IP`), and a
  burst of 20 then 1 new connection per second per IP per instance
  (`CONNECT_BURST_PER_IP`, `CONNECT_RATE_PER_IP_PER_SEC`;
  `backend/src/config.ts:34-36`), both refused at the HTTP upgrade before
  any connection exists (`backend/src/realtime/socket.ts:122-125`). Behind
  the gateway each replica keeps its own counters, so with 2 replicas an IP
  can hold up to 20 sockets in total ([capacity.md](capacity.md) "Limits
  configured for capacity").
- 3 sockets per session token per instance (`MAX_SOCKETS_PER_SESSION`,
  `backend/src/rateLimit.ts:13`), and a socket that has not said hello within
  30 s is dropped (`helloTimeoutMs`, `backend/src/config.ts:349`).
- 10 sessions per minute per IP and 60 per minute per /24
  (`backend/src/config.ts:54-55`; HTTP 429 `rate_limited`,
  `backend/src/session/constants.ts:137`).
- 200 matches per hour per device and per IP (`backend/src/config.ts:68-69`)
  and 20 rooms a device may end itself (skip, decline) per minute
  (`MATCH_CAP_PER_DEVICE_PER_MIN`, `backend/src/config.ts:70`); being
  skipped never counts. Hello or the automatic re-queue answers
  `rate_limited` (`backend/src/session/queueGate.ts:50-75`); a re-queue the
  partner caused skips the per-minute check (`queueGate.ts:20`).
- 3 accept windows let expire within 10 minutes puts the device on a 60 s
  cooldown (`ACCEPT_TIMEOUT_*`, `backend/src/safety/constants.ts:56-58`);
  hello answers `rate_limited` meanwhile.

## 2. How long can two people talk?

**There is no server-side cap on call duration.** The store's own comment
is explicit: "active rooms have no TTL (a call may run for days)"
(`backend/src/store/constants.ts:35-39`). `PENDING_ROOM_GRACE_MS` (1 h) is a
safety net on the *pending* (accept-window) state only. A search of
`backend/src/config.ts`, `backend/src/match/` and `backend/src/store/` for a
maximum call or room duration finds none; the only duration-shaped number is
`durationMs` in the `call:telemetry` schema, capped at 86,400,000 ms for
validation of the client's report (`backend/src/protocol.ts:228`), which
does not end anything.

The accept window (`MATCH_ACCEPT_TIMEOUT_MS`, default 30,000 ms, plus a
750 ms `matchAcceptGraceMs`; `backend/src/config.ts:37,367`) applies before
the call: a pending room whose members have not both accepted by the
deadline is ended by the sweeper. Once a room is active it stays active
until one of these happens:

| What ends an active call | Where |
|---|---|
| Either side presses Next (`call:skip`) or Stop (which disconnects) | `backend/src/match/MatchService.ts:413` (`skip`), `:652` (`disconnect`) |
| Either socket disconnects for any reason (tab closed, network drop, Socket.IO ping timeout after 20 s + 20 s) | `socket.ts:133-134`, `MatchService.disconnect` |
| The browser reports the peer connection failed (`call:failed`) after the 10 s connect timeout or an ICE failure after one restart | `backend/src/match/MatchService.ts:601-614`, `new-frontend/src/hooks/usePeerConnection.ts:45` |
| A report leads to a restriction, or the admin bans the device | `enforcement/EnforcementService.ts`, mirrored into the match store ban (`MatchService.ts:51-52`) |
| The instance holding the socket dies or stops: its sessions are removed by the surviving instances after 15 s (`instanceTtlMs`) or at once on graceful shutdown (`server:shutdown`, then the sockets are closed) | `MatchService.ts:207-231`, `:733-745` |
| The same device opens a second session elsewhere: the old socket is replaced and disconnected | `MatchService.ts:1040-1046` |

The client reconnects automatically (`reconnection: true`, delay 1 s to 10 s,
`new-frontend/src/hooks/useSignaling.ts:444-447`) and re-sends hello, but the
room is gone: the pair is re-queued, not reunited.

What the free tier adds:

- **Every deploy restarts the process, so every call drops.** Render
  redeploys on each commit to `main`; the process gets `SIGTERM`, emits
  `server:shutdown` to local sockets, and exits within `SHUTDOWN_GRACE_MS`
  (default 10,000 ms; `backend/src/config.ts:47`, `backend/src/index.ts:62-70`).
  With the memory store, nothing survives.
- **Spin-down ends calls too.** Render spins the service down after 15 min
  without inbound traffic (`render.yaml` header). The backend GETs its own
  `/healthz` every 10 min and the GitHub cron pings every 10 min, which
  keeps it warm most of the time, but the self-ping cannot wake a process
  that is already asleep and GitHub cron runs are best-effort
  (`keepalive.ts:8-9`, `.github/workflows/keepalive.yml` comment). A
  spin-down is a process stop: every socket and room goes with it.
- **Memory store loses rooms.** With no `REDIS_URL`, rooms, sessions, pair
  blocks and bans live in `MemoryStore` and are gone on restart.
- The hourly match cap (200 per device per hour) is a cap on *new matches*,
  not on the length of one call; a two-hour call consumes one match.

Side effect of long calls: coins. Each socket owned by an instance is swept
every 500 ms; once both `call:connected` have arrived, the caller earns
`coinsPerInterval` (5) for every full `coinIntervalMs` (60,000 ms) of
connected time, with no upper bound (`backend/src/config.ts:384-385`,
`MatchService.tickRewards`, `:776-836`). A 24 h call earns 7,200 coins per
side, which is more than the 3,000-coin month pack (`FLAG_DEFAULTS.coin_packs`,
`protocol.ts:682`). Coins start at `initialCoins` 0 (`config.ts:380`): device
ids are client-chosen, so a starting balance at or above
`gender_filter_coins_per_day` would give every fresh device (incognito window)
a free day of the filter; the backend logs `BILLING WARNING` when the two
values cross. After `friendAfterMs` (5 min, `config.ts:381`) the pair is
marked as friends.

## 3. Limits by component

"When exceeded" names the error code the client sees (socket ack
`{ ok: false, error }`, `server:error`, or an HTTP status). "Change" says
where the knob is: `env` (variable in `backend/.env.example`), `flag`
(admin API, live), or `code` (constant; rebuild).

### Transport (Socket.IO)

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Transport | WebSocket only (`transports: ["websocket"]`); long polling is never served | `realtime/socket.ts:126-130` | HTTP 400 "Transport unknown" (`test/integration/safety.test.ts` "long polling is not offered") | code |
| Frame size | 256 KiB (`MAX_HTTP_BUFFER_SIZE = 256 * 1024`), enforced in the parser so Bun's ws also honours it | `realtime/socket.ts:44,131-132`, `realtime/limitedParser.ts:38` | socket closed by the parser | code |
| Packets per connection | burst 400, then 100 per second (`PACKET_RATE_PER_CONNECTION`), counted in the parser for every packet, known event or not | `rateLimit.ts:27`, `realtime/limitedParser.ts:40` | socket closed (`socketLimits.test.ts` "packets faster than the packet budget") | code |
| Bytes per connection | burst 1 MiB, then 128 KiB per second (`PACKET_BYTES_PER_CONNECTION`) | `rateLimit.ts:28`, `realtime/limitedParser.ts:41` | socket closed | code |
| Connections per IP per instance | `MAX_CONNECTIONS_PER_IP` = 10, checked in `allowRequest` on the HTTP upgrade, before any Engine.IO connection or the session gate exists | `config.ts:34`, `realtime/socket.ts:69-117,122-125` | upgrade answered HTTP 400 `too_many_connections`; the Socket.IO client sees `websocket error` (`safety.test.ts` "a refused upgrade holds no connection") | env |
| New connections per IP per instance | burst `CONNECT_BURST_PER_IP` = 20, then `CONNECT_RATE_PER_IP_PER_SEC` = 1, same place | `config.ts:35-36`, `realtime/socket.ts:87-104` | HTTP 400 `rate_limited` | env |
| Sockets per session token per instance | `MAX_SOCKETS_PER_SESSION` = 3 (device id from the handshake token; off without the session gate). A client that dropped while the session gate awaited the store is not counted, since its `close` already fired | `rateLimit.ts:13`, `realtime/socket.ts:216-240` | handshake error `too_many_connections`, connection closed at once (`socketLimits.test.ts` "one session token may hold at most", "a client that drops during the session gate") | code |
| Refused handshake | a session-gate or per-session refusal closes the connection on the next tick instead of holding it for `connectTimeout` | `realtime/socket.ts:196-210` | n/a (`socketLimits.test.ts` "a refused session handshake is closed at once") | code |
| Hello deadline | `helloTimeoutMs` 30 s from connect to a well-formed `session:hello`; a malformed hello does not count | `config.ts:219,349`, `realtime/socket.ts:238-251` | socket disconnected, `chizzy_rate_limited_total{event="hello_timeout"}` (`socketLimits.test.ts` "never says hello") | code |
| Ping | `pingInterval` 20 s, `pingTimeout` 20 s, `connectTimeout` 10 s | `realtime/socket.ts:133-135` | socket dropped, client reconnects | code |
| Protocol version | `PROTOCOL_VERSION = 3` | `protocol.ts:14` | `unsupported_version` on hello | code |
| Gateway websocket idle | `proxy_read_timeout 5m` | `deploy/nginx/gateway.conf:181` | nginx closes the socket | config |
| Gateway REST body | 64k default, 1m on the larger routes | `deploy/nginx/gateway.conf:114,134` | 413 | config |

### Per-event rate classes (token bucket per socket)

Each socket has one bucket per class; an empty bucket answers
`rate_limited` (`rateLimit.ts:35-45`, `realtime/socket.ts:286-289`). Events
without a handler (unknown names, stray acks) never reach a bucket; only the
per-connection packet budget above bounds them.

| Class | Events | Capacity | Refill per second |
|---|---|---|---|
| `hello` | `session:hello` | 5 | 0.5 |
| `preferences` | `session:preferences` (an unchanged set is acknowledged without a match pass, `MatchService.ts:341-344`) | 5 | 1 |
| `control` | `match:accept`, `match:decline`, `call:connected`, `call:skip`, `spark:request` | 10 | 2 |
| `signal` | `rtc:signal`, `caption:segment` (outer bucket) | 200 | 50 |
| `chat` | `chat:send` | 10 | 2 |
| `typing` | `chat:typing` | 10 | 4 |
| `report` | `report:submit` | 3 | 1/20 (one per 20 s) |
| `telemetry` | `call:failed`, `call:telemetry`, `moderation:signal` | 20 | 1 |
### Session gate (`POST /api/session`)

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Sessions per IP per minute | 10 | `config.ts:54` | HTTP 429 `rate_limited` | env `SESSION_RATE_PER_IP_PER_MIN` |
| Sessions per /24 (IPv6 /48) per minute | 60 | `config.ts:55` | 429 | env `SESSION_RATE_PER_NETWORK_PER_MIN` |
| Session token TTL | 24 h (`SESSION_TOKEN_TTL_MS = DAY_MS`) | `session/constants.ts:38` | handshake refused, SPA fetches a new session | code |
| Age token TTL | 180 days, never slides | `session/constants.ts:40`, `SessionService.ts:121` | re-enter date of birth | code |
| Under-18 lockout | device 365 days, fingerprint 30 days | `session/constants.ts:47,53` | 403 `locked` / `underage` | code |
| Turnstile token | max 4,096 chars; required in production unless `TURNSTILE_DISABLED=true` | `protocol.ts:486`, `config.ts` superRefine | 403 `turnstile_failed` | env |
| Siteverify calls in flight | `TURNSTILE_MAX_INFLIGHT` 64 process-wide (session gate and takedown form), 5 s timeout each | `session/constants.ts`, `session/turnstile.ts` | 503 `closed` (takedowns: 403 `turnstile_failed`) without an outbound request | code |
| Request body | `SESSION_BODY_LIMIT_BYTES` 8 KiB; an over-cap `Content-Length` is refused before the body is read and the connection closed; compressed bodies refused | `http/constants.ts`, `http/body.ts` | 413 / 415 `invalid` | code |
| Queue size | flag `max_waiting` 5,000 (schema max 1,000,000) | `protocol.ts:666,690` | hello `matching_closed` "full" | flag |
| Matches per device / IP per hour | 200 / 200 (fixed 1 h window; device-IP binding kept 24 h) | `config.ts:56-57`, `session/constants.ts:57,67` | `rate_limited` on hello or re-queue, "a lot of matches this hour" | env `MATCH_CAP_PER_*_PER_HOUR` |
| Skips per device per minute | `MATCH_CAP_PER_DEVICE_PER_MIN` 20 (fixed 1 min window) rooms the device ended itself by `call:skip` or `match:decline`; a re-queue caused by the partner (`partner-skipped`, `partner-left`, `partner-declined`) is never refused by it | `config.ts:70`, `session/constants.ts:65`, `session/limits.ts:127-148`, `session/queueGate.ts:20,63-65`, `match/MatchService.ts:386,428` | `rate_limited` on hello or re-queue, "skipping very fast" (`socketLimits.test.ts` "skips matchCapPerDevicePerMin times", "being skipped never counts") | env `MATCH_CAP_PER_DEVICE_PER_MIN` |
| Kill switch, staffed hours | flags `matching_enabled`, `staffed_hours`, `new_sessions_enabled` | `protocol.ts:665-685`, `flags/flags.ts:141` | `matching_closed` with the banner, or 503 `closed` | flag |
| Client identity for every per-IP limit | `PROXY_IP_HEADER` only when `TRUST_PROXY=true` and the header is one IP literal (IPv4-mapped prefix and zone id dropped), else the TCP peer; list headers (`x-forwarded-for`, `forwarded`, `via`) refused at boot | `session/geo.ts` `requestIp`, `config.ts` superRefine | a junk header counts against the proxy's own address, never as a fresh identity | env |
| Active restriction | by device id and by fingerprint (device-fingerprint link 180 days); device IP and edge country noted 24 h for CSAM packets | `SessionService.ts`, `EnforcementService.activeForDevice`, `enforcement/constants.ts:98,100` | 403 `banned` with the restriction | code |
| Production secrets | `SESSION_SECRET` >= 32 chars, `ADMIN_TOKEN` >= 24 chars, each with >= 8 distinct characters | `config.ts` superRefine | the process refuses to start | env |

### REST (`backend/src/http`)

Every JSON route and the raw webhook route parse through `http/body.ts`
(`jsonBody`, `rawBody`): the cap is checked against `Content-Length` first
(413 and `Connection: close` before a byte of body is read), then
`express.json`/`express.raw` enforce it on chunked bodies, and `inflate` is
off (415 for `Content-Encoding`). The client IP for every per-IP bucket is the
TCP peer, or `PROXY_IP_HEADER` only with `TRUST_PROXY=true`; the header must
be single-valued (`x-real-ip`, `true-client-ip`, `cf-connecting-ip`), list
headers such as `X-Forwarded-For` are refused at startup because a client can
prepend to them.

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Header phase | `HTTP_HEADERS_TIMEOUT_MS` 15 s from the first byte | `http/constants.ts`, `server.ts` | 408, socket closed | code |
| Whole request | `HTTP_REQUEST_TIMEOUT_MS` 30 s (headers and body); checked every `HTTP_CONNECTIONS_CHECK_INTERVAL_MS` 5 s | same | 408, socket closed | code |
| Idle keep-alive | `HTTP_KEEP_ALIVE_TIMEOUT_MS` 65 s (above the gateway's 60 s so the proxy closes first) | same | socket closed | code |
| Headers per request | `HTTP_MAX_HEADERS_COUNT` 100; Node's 16 KiB header block | same | 431 | code |
| Requests per socket | `HTTP_MAX_REQUESTS_PER_SOCKET` 1,000 | same | `Connection: close` on the last one | code |
| Enforcement bodies | `ENFORCEMENT_BODY_LIMIT_BYTES` 16 KiB (`/api/appeals`, `/api/takedowns`) | `http/constants.ts` | 413 `too_large` | code |
| Enforcement reads / writes per IP | 30 burst, 0.5/s; 10 burst, 0.1/s (per instance) | `http/public.ts:77-78` | 429 `rate_limited` | code |
| Admin bodies, requests | `ADMIN_BODY_LIMIT_BYTES` 16 KiB; 120 burst, 2/s per IP after auth; 10 bad tokens per 15 min | `http/constants.ts`, `http/admin.ts:55-56,82` | 413, 429 | code |
| Per-IP bucket maps | cleared at 50,000 keys (`IpBuckets`), admin failures at 10,000 | `http/public.ts:43`, `http/admin.ts:103` | limits reset for everyone on that instance | code |
| `/readyz` | one `store.ping()` in flight at a time (concurrent hits share it); 1 s timeout | `http/app.ts` | 503 `unavailable` | code |
| `/metrics` | `METRICS_TOKEN` bearer; in production an unset token answers 404 (the route is closed, not open); `/healthz` does no I/O | `http/app.ts`, `server.ts` | 401 / 404 | env `METRICS_TOKEN` |

### Matching

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Accept window | `MATCH_ACCEPT_TIMEOUT_MS` 30,000 + grace 750 ms | `config.ts:37,370` | pending room ended by the sweeper; late accept gets `not_in_room` "the match expired" | env |
| Accept-timeout cooldown | a side that never pressed Accept gets a strike; `ACCEPT_TIMEOUT_STRIKES` 3 within `ACCEPT_TIMEOUT_WINDOW_MS` 10 min starts a `ACCEPT_TIMEOUT_COOLDOWN_MS` 60 s cooldown. Instant-mode sides never strike | `safety/constants.ts:56-58`, `MatchService.ts:282-288,698`, `safety/signals.ts:245-266` | hello `rate_limited` "You let 3 matches expire" (`socketLimits.test.ts` "letting 3 accept windows expire") | code |
| Pending room safety TTL | 1 h after the deadline (`PENDING_ROOM_GRACE_MS`) | `store/constants.ts:39` | store drops it | code |
| Active room TTL | none | `store/constants.ts:37` | n/a | n/a |
| Sweeper | every 500 ms; full recheck slice every 5 s with a 100,000 pair-check budget | `config.ts:379-381` | match latency grows | code |
| Relaxation ladder | topics stop being required after 5 s, same-language preference after 10 s; low-priority devices wait 4 s extra | `match/matchConfig.ts:109-111` | n/a (wider pool) | code |
| Decline / skip / report block | 30 s / 5 min / 24 h before the same pair can meet again; block history kept 24 h | `config.ts:388-390`, `MatchService.ts:50` | pair skipped by the matcher | code |
| Early skip | a partner leaving within 3 s counts; share over 0.6 after 10 calls gives low priority for 1 h | `match/matchConfig.ts:113-117` | slower matches | code |
| Risk score | 6 soft points in 24 h gives low priority (never a ban) | `matchConfig.ts:116`, `safety/constants.ts:39` | slower matches | code |
| Topics / name / photo | up to 10 topics, 32-char name, 150,000-char photo data URL (about 110 KB JPEG) | `protocol.ts:51-55` | `invalid_payload` | code |
| Instance heartbeat / TTL | 5 s / 15 s | `config.ts:382-383` | sessions of a silent instance removed, partners get `partner-unavailable` | code |
| Chat guard | links, handles and phone numbers hidden for the first 2 min of a call | `matchConfig.ts:112` | text masked | code |

### Chat, reports, evidence

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Chat message | 500 chars (`LIMITS.chatMax`); 10 burst, 2/s | `protocol.ts:56`, `rateLimit.ts:26` | `invalid_payload` / `rate_limited` | code |
| SDP / ICE candidate | 20,000 / 2,000 chars | `protocol.ts:58-59` | `invalid_payload` | code |
| Report details | 500 chars; evidence frame data URL 120,000 chars; up to 20 chat lines | `protocol.ts:57,61-62` | `invalid_payload` | code |
| Evidence decoded size | 4 B to 96 KiB JPEG (`EVIDENCE_MAX_BYTES = 96 * 1024`), must start with the JPEG magic | `enforcement/constants.ts:206-208`, `enforcement/evidence.ts:37-56` | frame silently dropped from the report | code |
| Evidence reads (admin download, restriction page) | a stored object over 96 KiB or without the JPEG magic is refused (the file size is checked before reading; S3 reads ask for at most 96 KiB + 1 byte); the admin download is `image/jpeg` (`EVIDENCE_CONTENT_TYPE`), `Content-Disposition: attachment`, `nosniff`, `no-store`; ids are server UUIDs checked against `EVIDENCE_ID_PATTERN` before any path or key is built | `enforcement/evidence.ts` `checkStored`, `FsEvidenceStore.get`, `S3EvidenceStore.get`, `http/admin.ts` `/reports/:id/evidence`, `enforcement/constants.ts:213,221` | 500 (error logged), nothing served | code |
| Reports per reporter | 5 per hour per device (`REPORTS_PER_HOUR`), 30 per hour per client IP across devices (`REPORTS_PER_IP_PER_HOUR`, wide because of CGNAT), one per room per reporter (claim kept 1 day) | `enforcement/constants.ts:34-40`, `EnforcementService.ts:admitReport` | `rate_limited`, duplicate ignored | code |
| Report after the call | allowed for 60 s after the room ended (`reportAfterEndMs: 60_000`) plus 5 s skew grace | `config.ts:380`, `enforcement/constants.ts:102` | `not_in_room` | code |
| Automatic action | a 10 min pause when the weights of distinct reporters in 24 h reach `AUTO_PAUSE_THRESHOLD` 1.6 (a reporter weighs 0.05 to 1: fresh device about 0.23, halved for calls under 2 s, so at least 2 established or 8 fresh reporters); reporters on one address (IPv4 address or IPv6 /64, stored as a salted hash) count once at their highest weight; everything else is human (ladder: warning, 10 min, 24 h, 7 d, permanent) | `enforcement/constants.ts:28-45`, `EnforcementService.ts:autoAction` | `banned` / restriction page | code |
| Admin restriction duration | only `RESTRICTION_DURATIONS_MS` 10 min, 24 h, 7 d, or `null` (permanent); omitted takes the next ladder rung | `protocol.ts:RESTRICTION_DURATIONS_MS`, `adminReportActionSchema` | 400 `invalid` | code |
| Appeals | 5 per device per day (charged only for the device's own restrictions), 10 per IP per hour, 1 per restriction, 48 h target | `enforcement/constants.ts:APPEALS_*`, `EnforcementService.ts:submitAppeal` | `rate_limited` / `already_appealed` | code |
| Takedowns | 5 per IP per hour; description 20 to 2,000 chars | `enforcement/constants.ts:115`, `protocol.ts:556-563` | `rate_limited` | code |
| Report log (memory store) | newest 10,000 | `store/constants.ts:14` | oldest dropped | code |
| Reporter index (who reported a device) | kept 30 days after the device's last report (`REPORTS_AGAINST_TTL_MS`): a Redis TTL, and the memory store prunes every 1,000 report writes | `store/constants.ts:41`, `store/MemoryStore.ts` `addReport` | older reporters no longer count toward the auto-pause threshold | code |
| Retention | records and evidence deleted 1 year after they stop mattering, audit entries 1 year after they were written (except those about a report on legal hold); CSAM evidence frozen at least 1 year; hourly check for a daily claim. A report whose evidence cannot be deleted keeps its record for the next day's sweep (counted as `evidenceErrors`), the rest of the sweep goes on | `enforcement/constants.ts:128-133`, `EnforcementService.ts` `sweepRetention` | n/a | code |
| Admin lists | 500 most recent (`ADMIN_LIST_LIMIT`), including the open-report queue (oldest 500 by creation, then sorted by severity and due clock); audit `limit` 1 to 500, default 100 | `enforcement/constants.ts:118`, `EnforcementService.ts:queue`, `http/admin.ts:67` | truncated | code |
| Enforcement memory store | expiring entries (room grace values, report claims, counters, device stats) are swept every 1,000 writes (`SWEEP_EVERY_WRITES`) once expired | `enforcement/MemoryEnforcementStore.ts` | n/a (bounded) | code |
| Admin wallet adjust | delta -1,000,000 to 1,000,000, non-zero; note 1 to 500 chars; optional `Idempotency-Key` header (8 to 64 of `[A-Za-z0-9_-]`) remembered 24 h (`ADMIN_IDEMPOTENCY_TTL_MS`): a repeat is refused, not applied | `protocol.ts:802-805`, `http/admin.ts` `idempotencyKey`, `enforcement/constants.ts:125-126` | 400; 409 `duplicate` | code |
| Admin notes | 2,000 chars | `protocol.ts:766,772,775` | 400 | code |

### TURN and media

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Credential TTL | `TURN_TTL_SECONDS` 7,200 (min 60) | `config.ts:44` | relay stops after expiry | env |
| Credential cache | one set per device for `TURN_CACHE_SECONDS` 300 | `matchConfig.ts:20` | n/a | env |
| New credential sets | `TURN_MAX_PER_DEVICE_HOUR` 20, `TURN_MAX_PER_IP_HOUR` 100 | `matchConfig.ts:21-22` | STUN only, `privateModeAllowed: false` | env |
| Video bitrate | flag `video_max_kbps` 900, `relay_video_max_kbps` 500 (schema 100 to 10,000); the SPA defaults to the same | `protocol.ts:669-670,693-694`, `usePeerConnection.ts:26` | sender caps `setParameters` | flag |
| Spend thresholds | 35 / 50 / 70 GB per UTC day: relay to 300 kbps, Hide my IP off, TURN off; polled every 15 min, one poller per cluster via `chizzy:lock:turn-spend`. 4 failed polls in a row (`SPEND_FAILSAFE_AFTER_FAILURES`): relay to 300 kbps and Hide my IP off until a poll succeeds | `matchConfig.ts:26,108`, `turn/constants.ts:67-80`, `spendPoller.ts` | flags stepped down, error logged, `chizzy_turn_spend_failsafe_total`; operator restores | env `TURN_SPEND_DAILY_GB` |
| Peer connect | 10 s connect timeout, one ICE restart | `usePeerConnection.ts:45` | `call:failed`, pair blocked 30 s | code |

### Spark, captions, billing

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Spark cooldown | 10 s per room (`SPARK.cooldownMs`), shared by both sides; card shown 12 s; last 20 prompt ids not repeated | `protocol.ts:68-75` | ack `rate_limited` | code |
| Spark state | per room, in memory on the instance that served it; forgotten after 1 h idle | `spark/SparkService.ts:10-12,41` | with several instances a pair may see two cooldown clocks | code |
| Caption segment | 1,024 UTF-8 bytes; 10 per second per socket and 2,048 relayed bytes per second per socket (`CAPTIONS.maxBytesPerSec`, burst 4,096), so captions carry no more than chat; links, handles and phone numbers hidden for the first `chatGuardMs` 2 min of a call like chat; interim every 250 ms | `protocol.ts:CAPTIONS`, `captions/CaptionRelay.ts` | `invalid_payload`; over either budget silently dropped (no ack, no error); redactions counted in `chizzy_captions_redacted_total` | code |
| Caption support | SpeechRecognition: Chrome and Android Chrome, Safari 14.1+; not Firefox. Translation: Chrome 138+ Translator API | `captions/speech.ts:6-7`, `captions/translator.ts:2-3` | toggle disabled | n/a |
| Billing REST | per IP: reads 30 burst / 0.5 per s, writes (orders, unlock) 10 / 0.1 per s, webhook 60 / 1 per s; per device: orders 5 / 1 per 5 min, verify 20 / 1 per s; JSON body `BILLING_BODY_LIMIT_BYTES` 8 KiB, webhook `WEBHOOK_BODY_LIMIT_BYTES` 64 KiB through `http/body.ts` (the webhook body is never inflated, so the MAC covers what was sent) | `http/billing.ts:47-55,117`, `http/constants.ts` | 429 `rate_limited`, 413 / 415 | code |
| Order records | unpaid orders live `UNPAID_ORDER_TTL_MS` 24 h (Redis TTL; the memory store sweeps them and, past `ORDERS_MAX` 2,000, drops the oldest unpaid first); paid orders and the per-order credit claim are kept for good | `billing/WalletStore.ts:29-38` | `order_unknown` after a day for a Checkout nobody paid | code |
| Coin packs | 1 to 10 packs; each 1 to 1,000,000 coins, 1 to 100,000 INR; flag string 2,000 chars | `protocol.ts:581-586,700-702` | flag rejected | flag `coin_packs` |
| Gender filter | `gender_filter_coins_per_day` 100 x 1 / 7 / 30 days; starting balance `initialCoins` 0, so a fresh device id never unlocks for free (raise it only together with a price above it) | `protocol.ts:577,680`, `config.ts:380` | 402 `insufficient_coins` | flag / code |
| Unlock lapse | checked on `session:preferences` and on every (re)queue, not mid-wait: a filter that expires while the device is waiting or in a call applies until that queue entry ends (one extra match at most) | `MatchService.ts:323,900` | `premium_required` on the next (re)queue | code |
| Billing on the memory store | refused: `billing_disabled` and "BILLING DISABLED" at boot when Razorpay keys are set without `REDIS_URL` | `billing/index.ts:49`, `render.yaml` comment | orders off | attach Redis |

### Process and cluster

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Redis lock | lease 3 s, renewed every 1 s by the holder while its section runs (`LOCK_RENEW_SHARE`) for at most 30 s (`LOCK_HOLD_MAX_MS`, so a hung section lapses instead of freezing every replica), wait 10 s, backoff 4 to 50 ms; renewal and release are token-fenced Lua scripts loaded once | `store/constants.ts:27-41`, `store/RedisStore.ts` | error log when a lease is lost (a stall longer than 3 s, Redis unreachable, a section over 30 s) because another replica may have entered; callers fail `internal` after 10 s | code |
| Redis timeouts | connect 5 s, command 5 s (also while queued during an outage), 2 retries; one option set for the store, adapter and feature-store clients | `store/constants.ts:21-25`, `store/RedisStore.ts` `REDIS_CLIENT_OPTIONS` | `/readyz` 503; handlers fail | code |
| Redis key parts | ids embedded in match-store keys must match `[A-Za-z0-9_.-]{1,128}` (UUIDs, Socket.IO ids, instance ids) | `store/RedisStore.ts` `KEY_PART_RE` | the call rejects (`internal`) before anything reaches Redis | code |
| Matching status (staffed hours) | computed at most once per minute per flag set; outside the window the search for the next opening scans up to 1,440 minutes (about 2 ms with the cached formatter, 60 ms before) | `flags/flags.ts` `FlagsReader.status` | n/a | code |
| Sentry events | at most 30 per minute and process (`SENTRY_MAX_EVENTS_PER_WINDOW`, `SENTRY_BUDGET_WINDOW_MS`); past it errors are only logged and the next window's first event reports how many were dropped. IDs, addresses, emails and data URLs in error messages are masked | `observability/constants.ts:7-14`, `observability/sentry.ts` `captureError`, `scrubMessage` | dropped (logged locally) | code |
| Shutdown grace | `SHUTDOWN_GRACE_MS` 10,000; compose `stop_grace_period: 15s` | `config.ts:46`, `docker-compose.yml` | process killed | env |
| Keep-alive | every 10 min to `KEEPALIVE_URL` (default `RENDER_EXTERNAL_URL/healthz`), 10 s request timeout | `keepalive.ts:14-15`, `config.ts:337` | warning logged | env |
| Container logs | json-file 10 MB x 3 | `docker-compose.yml` `x-logging` | oldest rotated out | config |
| Gateway upstream | `fail_timeout=2s`, one failed connect marks a replica down | `deploy/nginx/gateway.conf:32-36` | traffic shifts to the other replica | config |

### Hosting platforms

| Platform | Limit | Source |
|---|---|---|
| Render Free (backend) | 0.1 CPU, 512 MB, single instance, ephemeral filesystem, spin-down after 15 min idle, 750 instance hours/month | render.com/docs/free; `render.yaml` header |
| Vercel Hobby (frontend mirror) | non-commercial use only; the SPA is static (`vercel.json` rewrites everything to `index.html`, no functions), so Vercel function limits do not apply. Must not serve the paid product | `DEPLOYMENT.md:195`, `README.md:268`, `new-frontend/vercel.json` |
| Cloudflare Pages (frontend, production free host) | commercial use allowed; unlimited bandwidth and requests; 500 builds/month (direct upload does not count); 25 MiB per file (largest model 11.8 MiB); no Pages Functions used | `DEPLOYMENT.md` "Cloudflare Pages" |
| Cloudflare TURN | cost-driven only; the spend poller above is the cap | `turn/spendPoller.ts` |

## 4. Known weaknesses and what raises each ceiling

| Weakness | Effect | What raises the ceiling |
|---|---|---|
| One global Redis match lock (`lock:match`, `store/constants.ts`) | Matching throughput does not grow with replicas; all hello/skip/accept/sweeps serialise across the cluster | Shard the queue (per topic or language partition, one lock each) or move the match pass to a single elected matcher with lock-free enqueue; measure first with the LB-12 3,000-socket run |
| Memory store on the free tier | Any restart or spin-down loses everything in section 5; billing is refused | Attach a persistent Redis (`REDIS_URL`; Upstash free is persistent, Render Key Value free is not, per `render.yaml`) and set `EVIDENCE_S3_*` |
| Single region, single host | The compose stack is one EC2 host; Render Free is `singapore` only. A host outage is a full outage and far users see higher RTT on signalling | Second host behind the same Cloudflare hostname with a shared Redis; Redis replica or managed Redis for failover |
| No server-side media | There is no recording, no server-side frame sampling or hash matching; moderation is on-device only (`README.md` "Known limitations") | An SFU or sampling relay, at the cost of bandwidth, latency and privacy posture |
| Spark state in memory per instance | Two instances give a pair two cooldown clocks (looser, not broken); history lost on restart | Keep `RoomSpark` in Redis keyed by room id |
| Captions Chrome-only, translation Chrome 138+ | Firefox has no SpeechRecognition; Safari lacks the Translator API | Server- or cloud-side ASR and MT, which would send audio or text off-device |
| Payments need a durable store | Wallets, unlocks and Razorpay order records live in `WalletStore`; the memory variant vanishes on restart, so the backend refuses orders without Redis | Redis with AOF (already the compose default) plus the nightly S3 snapshot (`README.md` "Scaling notes") |
| TURN cost | Relayed calls are metered egress; the poller degrades features at 35 / 50 / 70 GB per day and never restores them by itself | Raise `TURN_SPEND_DAILY_GB`, or keep Hide my IP behind coins |
| Connect backlog on reconnect storms | Run B in capacity.md: 330 failed handshakes when four generators started at once on a saturated host (`kern.ipc.somaxconn` 128 on macOS) | Linux `net.core.somaxconn` 4096 (default on current kernels); stagger deploys; watch connection errors during a deploy |
| In-memory per-IP buckets key on the full IPv6 address | `ConnectionGate` (`realtime/socket.ts`), `IpBuckets` (`http/public.ts`) and the gateway `limit_req` zones (`deploy/nginx/gateway.conf:121-130`) see each IPv6 address as a new client, so one /64 subscriber can rotate addresses around the connect, REST and admin burst limits; the store-backed session rate, match caps and enforcement per-IP counters already bucket per /64 (`session/geo.ts` `ipBuckets`) | Key those buckets on `ipBuckets(ip).ip` and the nginx zones on a `/64` map of `$chizzy_limit_key`, at the cost of sharing a bucket across one household or carrier prefix |
| Deploy drops calls | Compose and Render both restart the replicas on deploy; clients reconnect and are re-queued, not reunited | Rolling restart one replica at a time (sessions of the stopped replica are re-queued on the other via `shutdown()`), or room reattachment by device id (not implemented) |

## 5. Data loss matrix

What is lost when something restarts. "Memory" is the free tier (no
`REDIS_URL`); "Redis" is the compose stack (Redis with `appendonly yes`,
`appendfsync everysec`, named volume `redis-data`; evidence on the
`evidence-data` volume or S3).

| Event | Sockets and live calls | Sessions and queue | Rooms | Flags | Restrictions and bans | Reports, appeals, audit | Evidence frames | Wallets, unlocks, orders | Spark cooldowns | Session rate / match caps / lockouts |
|---|---|---|---|---|---|---|---|---|---|---|
| Backend restart or deploy, memory store | lost | lost | lost | reset to `FLAG_DEFAULTS` | lost | lost | lost on Render (ephemeral disk) unless `EVIDENCE_S3_BUCKET` | lost (billing is disabled anyway) | lost | lost |
| Backend restart or deploy, Redis | lost (clients reconnect, re-queue) | removed by the stopping replica, partners re-queued | lost | kept | kept | kept | kept (volume or S3) | kept | lost (instance memory) | kept |
| One replica lost (crash, OOM) with Redis | that replica's sockets and calls lost; partners on the other replica get `partner-unavailable` within 15 s | that replica's sessions reaped by the survivors | lost for affected pairs | kept | kept | kept | kept | kept | lost on that replica | kept |
| Redis lost (process down) | sockets stay up but every handler fails `internal`; `/readyz` 503 | effectively frozen until Redis returns | frozen | last cached value per instance | cannot be checked | cannot be written | kept (not in Redis) | cannot be read or written | kept in memory | cannot be checked (fail-open on caps, `queueGate.ts:52-54`) |
| Redis data loss (volume gone) | as above until a fresh Redis starts | lost | lost | reset to defaults | lost | lost | kept on the evidence volume or S3, but orphaned from their reports | lost | n/a | lost |
| Render spin-down (free tier) | lost; first visitor waits about 1 min | lost | lost | reset | lost | lost | lost | n/a | lost | lost |
| Frontend host restart (nginx, Vercel, Pages) | nothing: the SPA is static and the socket goes to the API host | nothing | nothing | nothing | nothing | nothing | nothing | nothing | nothing | nothing |

Session tokens and age tokens are signed with `SESSION_SECRET`; they survive
any restart as long as the secret is the same (`render.yaml` generates one
once; the compose `.env` holds it). A backend started without
`SESSION_SECRET` outside production makes a random one, so every token dies
with the process (`config.ts:359-360`).

## Validation

Every number was read from the files cited at commit `472644e` on 2026-10-11.
Load figures are from [capacity.md](capacity.md), measured 2026-10-04 with
`node scripts/loadtest/loadtest.ts` on an Apple M3 Pro with a single process
and the memory store. No measurement exists yet for Render Free, the
two-replica stack, the gateway or the Redis lock; the estimates above say so.
