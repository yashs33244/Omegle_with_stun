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
| Session creation | `SESSION_RATE_PER_IP_PER_MIN` 10, `SESSION_RATE_PER_NETWORK_PER_MIN` 60 (per /24, or /48 for IPv6) | `backend/src/config.ts:53-54`, `docker-compose.yml` comment |
| Matches per hour | `MATCH_CAP_PER_DEVICE_PER_HOUR` 200, `MATCH_CAP_PER_IP_PER_HOUR` 200 | `backend/src/config.ts:55-56` |
| Queue size | flag `max_waiting` default 5,000; over it hello is refused with `matching_closed` | `backend/src/protocol.ts:664`, `backend/src/session/queueGate.ts:44-45` |
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
| Websocket idle | `proxy_read_timeout 1h` on `/socket.io/`; Socket.IO pings every 20 s (`pingInterval: 20_000`, `pingTimeout: 20_000`) | `deploy/nginx/gateway.conf:143`, `backend/src/realtime/socket.ts:60-61` |
| Replica loss detection | heartbeat every 5 s (`heartbeatIntervalMs: 5_000`); sessions of an instance silent for 15 s (`instanceTtlMs: 15_000`) are removed by the others and their partners get `partner-unavailable` | `backend/src/config.ts:371-372`, `backend/src/match/MatchService.ts:717-723` |
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
  `backend/src/config.ts:368`) on every replica serialise through
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

### Per-user caps that apply in both topologies

Whatever the topology, one person or one network can never take more than:

- 10 sockets per IP per backend instance (`MAX_CONNECTIONS_PER_IP`), and a
  burst of 20 then 1 new connection per second per IP per instance
  (`CONNECT_BURST_PER_IP`, `CONNECT_RATE_PER_IP_PER_SEC`;
  `backend/src/config.ts:34-36`). Behind the gateway each replica keeps its
  own counters, so with 2 replicas an IP can hold up to 20 sockets in total
  ([capacity.md](capacity.md) "Limits configured for capacity").
- 10 sessions per minute per IP and 60 per minute per /24
  (`backend/src/config.ts:53-54`; HTTP 429 `rate_limited`,
  `backend/src/session/constants.ts:128`).
- 200 matches per hour per device and per IP (`backend/src/config.ts:55-56`;
  hello or the automatic re-queue answers `rate_limited`,
  `backend/src/session/queueGate.ts:51`).

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
| Either side presses Next (`call:skip`) or Stop (which disconnects) | `backend/src/match/MatchService.ts:394` (`skip`), `:633` (`disconnect`) |
| Either socket disconnects for any reason (tab closed, network drop, Socket.IO ping timeout after 20 s + 20 s) | `socket.ts:60-61`, `MatchService.disconnect` |
| The browser reports the peer connection failed (`call:failed`) after the 10 s connect timeout or an ICE failure after one restart | `backend/src/match/MatchService.ts:586-590`, `new-frontend/src/hooks/usePeerConnection.ts:45` |
| A report leads to a restriction, or the admin bans the device | `enforcement/EnforcementService.ts`, mirrored into the match store ban (`MatchService.ts:50-51`) |
| The instance holding the socket dies or stops: its sessions are removed by the surviving instances after 15 s (`instanceTtlMs`) or at once on graceful shutdown (`server:shutdown`, then the sockets are closed) | `MatchService.ts:206-228`, `:717-723` |
| The same device opens a second session elsewhere: the old socket is replaced and disconnected | `MatchService.ts:1022-1025` |

The client reconnects automatically (`reconnection: true`, delay 1 s to 10 s,
`new-frontend/src/hooks/useSignaling.ts:444-447`) and re-sends hello, but the
room is gone: the pair is re-queued, not reunited.

What the free tier adds:

- **Every deploy restarts the process, so every call drops.** Render
  redeploys on each commit to `main`; the process gets `SIGTERM`, emits
  `server:shutdown` to local sockets, and exits within `SHUTDOWN_GRACE_MS`
  (default 10,000 ms; `backend/src/config.ts:46`, `backend/src/index.ts:62-70`).
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
connected time, with no upper bound (`backend/src/config.ts:373-374`,
`MatchService.tickRewards`, `:756-815`). A 24 h call earns 7,200 coins per
side, which is more than the 3,000-coin month pack (`FLAG_DEFAULTS.coin_packs`,
`protocol.ts:682`). Coins start at `initialCoins` 100 (`config.ts:375`). After
`friendAfterMs` (5 min, `config.ts:376`) the pair is marked as friends.

## 3. Limits by component

"When exceeded" names the error code the client sees (socket ack
`{ ok: false, error }`, `server:error`, or an HTTP status). "Change" says
where the knob is: `env` (variable in `backend/.env.example`), `flag`
(admin API, live), or `code` (constant; rebuild).

### Transport (Socket.IO)

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Frame size | 256 KiB (`MAX_HTTP_BUFFER_SIZE = 256 * 1024`), enforced in the parser so Bun's ws also honours it | `realtime/socket.ts:43,58-59`, `realtime/limitedParser.ts` | socket closed by the parser | code |
| Connections per IP per instance | `MAX_CONNECTIONS_PER_IP` = 10 | `config.ts:34` | handshake error `too_many_connections` | env |
| New connections per IP per instance | burst `CONNECT_BURST_PER_IP` = 20, then `CONNECT_RATE_PER_IP_PER_SEC` = 1 | `config.ts:35-36` | handshake error `rate_limited` | env |
| Ping | `pingInterval` 20 s, `pingTimeout` 20 s, `connectTimeout` 10 s | `realtime/socket.ts:60-62` | socket dropped, client reconnects | code |
| Protocol version | `PROTOCOL_VERSION = 3` | `protocol.ts:14` | `unsupported_version` on hello | code |
| Gateway websocket idle | `proxy_read_timeout 1h` | `deploy/nginx/gateway.conf:143` | nginx closes the socket | config |
| Gateway REST body | 64k default, 1m on the larger routes | `deploy/nginx/gateway.conf:114,134` | 413 | config |

### Per-event rate classes (token bucket per socket)

Each socket has one bucket per class; an empty bucket answers
`rate_limited` (`rateLimit.ts:21-31`, `realtime/socket.ts:193-196`).

| Class | Events | Capacity | Refill per second |
|---|---|---|---|
| `hello` | `session:hello` | 5 | 0.5 |
| `preferences` | `session:preferences` | 5 | 1 |
| `control` | `match:accept`, `match:decline`, `call:connected`, `call:skip`, `spark:request` | 10 | 2 |
| `signal` | `rtc:signal`, `caption:segment` (outer bucket) | 200 | 50 |
| `chat` | `chat:send` | 10 | 2 |
| `typing` | `chat:typing` | 10 | 4 |
| `report` | `report:submit` | 3 | 1/20 (one per 20 s) |
| `telemetry` | `call:failed`, `call:telemetry`, `moderation:signal` | 20 | 1 |

### Session gate (`POST /api/session`)

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Sessions per IP per minute | 10 | `config.ts:53` | HTTP 429 `rate_limited` | env `SESSION_RATE_PER_IP_PER_MIN` |
| Sessions per /24 (IPv6 /48) per minute | 60 | `config.ts:54` | 429 | env `SESSION_RATE_PER_NETWORK_PER_MIN` |
| Session token TTL | 24 h (`SESSION_TOKEN_TTL_MS = DAY_MS`) | `session/constants.ts:38` | handshake refused, SPA fetches a new session | code |
| Age token TTL | 180 days, never slides | `session/constants.ts:40`, `SessionService.ts:121` | re-enter date of birth | code |
| Under-18 lockout | device 365 days, fingerprint 30 days | `session/constants.ts:47,53` | 403 `locked` / `underage` | code |
| Turnstile token | max 4,096 chars; required in production unless `TURNSTILE_DISABLED=true` | `protocol.ts:484`, `config.ts` superRefine | 403 `turnstile_failed` | env |
| Queue size | flag `max_waiting` 5,000 (schema max 1,000,000) | `protocol.ts:664,688` | hello `matching_closed` "full" | flag |
| Matches per device / IP per hour | 200 / 200 (fixed 1 h window; device-IP binding kept 24 h) | `config.ts:55-56`, `session/constants.ts:57,59` | `rate_limited` on hello or re-queue | env `MATCH_CAP_PER_*_PER_HOUR` |
| Kill switch, staffed hours | flags `matching_enabled`, `staffed_hours`, `new_sessions_enabled` | `protocol.ts:663-683`, `flags/flags.ts:141` | `matching_closed` with the banner, or 503 `closed` | flag |
| Client identity for every per-IP limit | `PROXY_IP_HEADER` only when `TRUST_PROXY=true` and the header is one IP literal (IPv4-mapped prefix and zone id dropped), else the TCP peer; list headers (`x-forwarded-for`, `forwarded`, `via`) refused at boot | `session/geo.ts` `requestIp`, `config.ts` superRefine | a junk header counts against the proxy's own address, never as a fresh identity | env |
| Active restriction | by device id and by fingerprint (device-fingerprint link 180 days); device IP and edge country noted 24 h for CSAM packets | `SessionService.ts`, `EnforcementService.activeForDevice`, `enforcement/constants.ts:98,100` | 403 `banned` with the restriction | code |
| Production secrets | `SESSION_SECRET` >= 32 chars, `ADMIN_TOKEN` >= 24 chars, each with >= 8 distinct characters | `config.ts` superRefine | the process refuses to start | env |

### Matching

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Accept window | `MATCH_ACCEPT_TIMEOUT_MS` 30,000 + grace 750 ms | `config.ts:37,367` | pending room ended by the sweeper; late accept gets `not_in_room` "the match expired" | env |
| Pending room safety TTL | 1 h after the deadline (`PENDING_ROOM_GRACE_MS`) | `store/constants.ts:39` | store drops it | code |
| Active room TTL | none | `store/constants.ts:37` | n/a | n/a |
| Sweeper | every 500 ms; full recheck slice every 5 s with a 100,000 pair-check budget | `config.ts:368-370` | match latency grows | code |
| Relaxation ladder | topics stop being required after 5 s, same-language preference after 10 s; low-priority devices wait 4 s extra | `match/matchConfig.ts:109-111` | n/a (wider pool) | code |
| Decline / skip / report block | 30 s / 5 min / 24 h before the same pair can meet again; block history kept 24 h | `config.ts:377-379`, `MatchService.ts:49` | pair skipped by the matcher | code |
| Early skip | a partner leaving within 3 s counts; share over 0.6 after 10 calls gives low priority for 1 h | `match/matchConfig.ts:113-117` | slower matches | code |
| Risk score | 6 soft points in 24 h gives low priority (never a ban) | `matchConfig.ts:116`, `safety/constants.ts:39` | slower matches | code |
| Topics / name / photo | up to 10 topics, 32-char name, 150,000-char photo data URL (about 110 KB JPEG) | `protocol.ts:51-55` | `invalid_payload` | code |
| Instance heartbeat / TTL | 5 s / 15 s | `config.ts:371-372` | sessions of a silent instance removed, partners get `partner-unavailable` | code |
| Chat guard | links, handles and phone numbers hidden for the first 2 min of a call | `matchConfig.ts:112` | text masked | code |

### Chat, reports, evidence

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Chat message | 500 chars (`LIMITS.chatMax`); 10 burst, 2/s | `protocol.ts:56`, `rateLimit.ts:26` | `invalid_payload` / `rate_limited` | code |
| SDP / ICE candidate | 20,000 / 2,000 chars | `protocol.ts:58-59` | `invalid_payload` | code |
| Report details | 500 chars; evidence frame data URL 120,000 chars; up to 20 chat lines | `protocol.ts:57,61-62` | `invalid_payload` | code |
| Evidence decoded size | 4 B to 96 KiB JPEG (`EVIDENCE_MAX_BYTES = 96 * 1024`), must start with the JPEG magic | `enforcement/constants.ts:194-196`, `safety/evidence.ts:41-42` | frame silently dropped from the report | code |
| Reports per reporter | 5 per hour (`REPORTS_PER_HOUR`), one per room per reporter (claim kept 1 day) | `enforcement/constants.ts:34`, `EnforcementService.ts:248-251` | `rate_limited`, duplicate ignored | code |
| Report after the call | allowed for 60 s after the room ended (`reportAfterEndMs: 60_000`) plus 5 s skew grace | `config.ts:380`, `enforcement/constants.ts:102` | `not_in_room` | code |
| Automatic action | a 10 min pause when weighted reports in 24 h reach the threshold; everything else is human (ladder: warning, 10 min, 24 h, 7 d, permanent) | `enforcement/constants.ts:28-37` | `banned` / restriction page | code |
| Appeals | 5 per device per day, 1 per restriction, 48 h target | `enforcement/constants.ts:111-113,67` | `rate_limited` / `already_appealed` | code |
| Takedowns | 5 per IP per hour; description 20 to 2,000 chars | `enforcement/constants.ts:115`, `protocol.ts:556-563` | `rate_limited` | code |
| Report log (memory store) | newest 10,000 | `store/constants.ts:14` | oldest dropped | code |
| Retention | records and evidence deleted 1 year after they stop mattering; CSAM evidence frozen at least 1 year; hourly check | `enforcement/constants.ts:121-125` | n/a | code |
| Admin lists | 500 most recent (`ADMIN_LIST_LIMIT`); audit `limit` 1 to 500, default 100 | `enforcement/constants.ts:118`, `http/admin.ts:67` | truncated | code |
| Admin wallet adjust | delta -1,000,000 to 1,000,000, non-zero; note 1 to 500 chars | `protocol.ts:802-805` | 400 | code |
| Admin notes | 2,000 chars | `protocol.ts:766,772,775` | 400 | code |

### TURN and media

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Credential TTL | `TURN_TTL_SECONDS` 7,200 (min 60) | `config.ts:43` | relay stops after expiry | env |
| Credential cache | one set per device for `TURN_CACHE_SECONDS` 300 | `matchConfig.ts:20` | n/a | env |
| New credential sets | `TURN_MAX_PER_DEVICE_HOUR` 20, `TURN_MAX_PER_IP_HOUR` 100 | `matchConfig.ts:21-22` | STUN only, `privateModeAllowed: false` | env |
| Video bitrate | flag `video_max_kbps` 900, `relay_video_max_kbps` 500 (schema 100 to 10,000); the SPA defaults to the same | `protocol.ts:667-668,691-692`, `usePeerConnection.ts:26` | sender caps `setParameters` | flag |
| Spend thresholds | 35 / 50 / 70 GB per UTC day: relay to 300 kbps, Hide my IP off, TURN off; polled every 15 min, one poller per cluster via `chizzy:lock:turn-spend` | `matchConfig.ts:26,108`, `turn/constants.ts:67-69`, `spendPoller.ts` | flags stepped down, error logged; operator restores | env `TURN_SPEND_DAILY_GB` |
| Peer connect | 10 s connect timeout, one ICE restart | `usePeerConnection.ts:45` | `call:failed`, pair blocked 30 s | code |

### Spark, captions, billing

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Spark cooldown | 10 s per room (`SPARK.cooldownMs`), shared by both sides; card shown 12 s; last 20 prompt ids not repeated | `protocol.ts:68-75` | ack `rate_limited` | code |
| Spark state | per room, in memory on the instance that served it; forgotten after 1 h idle | `spark/SparkService.ts:10-12,41` | with several instances a pair may see two cooldown clocks | code |
| Caption segment | 1,024 UTF-8 bytes; 10 per second per socket; interim every 250 ms | `protocol.ts:78-85` | `invalid_payload`; over rate silently dropped (no ack, no error) | code |
| Caption support | SpeechRecognition: Chrome and Android Chrome, Safari 14.1+; not Firefox. Translation: Chrome 138+ Translator API | `captions/speech.ts:6-7`, `captions/translator.ts:2-3` | toggle disabled | n/a |
| Billing REST | per IP: reads 30 burst / 0.5 per s, order writes 10 / 0.1 per s, verify 20 / 1 per s, webhook 60 / 1 per s; JSON body 8 KB | `http/billing.ts:45-50` | 429 `rate_limited` | code |
| Coin packs | 1 to 10 packs; each 1 to 1,000,000 coins, 1 to 100,000 INR; flag string 2,000 chars | `protocol.ts:581-586,700-702` | flag rejected | flag `coin_packs` |
| Gender filter | `gender_filter_coins_per_day` 100 x 1 / 7 / 30 days | `protocol.ts:577,680` | 402 `insufficient_coins` | flag |
| Billing on the memory store | refused: `billing_disabled` and "BILLING DISABLED" at boot when Razorpay keys are set without `REDIS_URL` | `billing/index.ts:49`, `render.yaml` comment | orders off | attach Redis |

### Process and cluster

| Limit | Value | Source | When exceeded | Change |
|---|---|---|---|---|
| Redis lock | lease 3 s, wait 10 s, backoff 4 to 50 ms | `store/constants.ts:28-33` | error log when a section overruns; callers fail `internal` after 10 s | code |
| Redis timeouts | connect 5 s, command 5 s, 2 retries | `store/constants.ts:21-25` | `/readyz` 503; handlers fail | code |
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
with the process (`config.ts:349-350`).

## Validation

Every number was read from the files cited at commit `472644e` on 2026-10-11.
Load figures are from [capacity.md](capacity.md), measured 2026-10-04 with
`node scripts/loadtest/loadtest.ts` on an Apple M3 Pro with a single process
and the memory store. No measurement exists yet for Render Free, the
two-replica stack, the gateway or the Redis lock; the estimates above say so.
