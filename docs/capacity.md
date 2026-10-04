# Capacity and load testing

The signaling server only relays small messages (hello, match events, SDP,
ICE candidates, chat). Media is peer to peer or goes through Cloudflare TURN,
so the server's limits are sockets, message rate and the matching loop, not
bandwidth. This page records how to load test it and what we measured.

LB-12 asks for a test at 3x the written expected peak. **Written expected
peak for launch: 1,000 concurrent sockets** (LAUNCH_PLAN LB-12 working
assumption), so the pre-launch target is **3,000 sockets with half of them in
calls, plus a 2 hour soak**. That test has NOT been run yet (see "Still to do").

## The load test script

`scripts/loadtest/loadtest.ts` simulates N users, each going through the same
steps as the SPA (protocol v3):

1. `POST /api/session` (skip with `--skip-session` for a backend without the session gate)
2. Socket.IO handshake over the websocket transport with `auth.sessionToken`
3. `session:hello` (instant or preview mode)
4. `match:found`, then `match:accept` in preview mode (in instant mode the
   server accepts; the script accepts by hand after 1.5 s only if it did not,
   and reports that as `instant fallback accepts`)
5. `call:start`, then an offer/answer and `--signals` candidate round trips
   through `rtc:signal`
6. one `chat:send` (acked), then the initiator presses Next (`call:skip`)
   after `--hold` ms; the server re-queues both users and the loop repeats

It reports peak sockets, matches, call starts and completions, errors by code,
and latency percentiles: `connect_ms` (handshake), `hello_ack_ms`, `match_ms`
(queued to `match:found`), `found_to_call_start_ms`, `offer_answer_ms`,
`signal_rtt_ms` (one relay round trip), `chat_ack_ms`, `session_ms`. It also
prints the generator's own event-loop lag: when that is high, the load
generator is the bottleneck, not the server.

```sh
cd backend && bun install          # the script uses backend/node_modules (socket.io-client)
cd ..
node scripts/loadtest/loadtest.ts --help
node scripts/loadtest/loadtest.ts --url http://127.0.0.1:3004 --users 1000 --ramp 30 --duration 60 --hold 30000
```

Requirements on the target (every virtual user comes from one IP):

- `MAX_CONNECTIONS_PER_IP` far above the user count (for example 100000).
- `TURNSTILE_DISABLED=true`, or the Turnstile test secret
  `1x0000000000000000000000000000000AA` (the script sends Cloudflare's dummy
  test token unless `--turnstile-token` is given).
- The session gate's per-IP and /24 buckets and the hourly match caps raised
  for the test, or every user after the first few is rate limited.
- Never point it at production: it creates thousands of sessions and fills
  the queue with users who never show video.

Type check: `backend/node_modules/.bin/tsc -p scripts/loadtest`. The script
runs on Node 22.18+ directly (type stripping), with no build step.

## Results: 2026-10-04, single backend, local machine

**Setup.** Apple M3 Pro (11 cores), 18 GiB RAM, macOS 26.6.2, Node 22.23.3.
One backend process (`node dist/index.js`, memory store, no Redis, no gateway,
`MAX_CONNECTIONS_PER_IP=100000`), load generator on the same machine. Base
commit 3096285 plus this lane: `/api/session` and server-side instant accept
were still being built in parallel, so every run used `--skip-session` and
`--mode preview` (both sides accept). Each user had the same topic and
language, so matching never had to relax.

**Caveat: the machine was heavily loaded.** Other build and test jobs ran on
the same machine during the whole test: the load average was 61 to 80 on 11
cores. The server's event-loop lag went up while its own CPU time stayed low,
which means it was waiting for a CPU, not working. The latency tails below are
therefore pessimistic and noisy. Treat them as an upper bound, not a
benchmark.

| Run | Users | Ramp + steady | Call length | Peak sockets | Calls started | Calls/s | Errors | Server CPU | Server peak RSS | Server loop lag p99 / max |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 200 | 20 s + 60 s | 5 s | 200 | 1,409 | 17.2 | 0 | 5.3 s in 82 s (about 6% of a core) | 98 MB | 131 / 585 ms |
| C | 1,000 | 30 s + 60 s | 5 s (churn) | 1,000 | 7,118 | 67.6 | 0 | 15.3 s in 105 s (about 15%) | 151 MB | 213 / 754 ms |
| D | 1,000 | 30 s + 90 s | 30 s | 1,000 | 2,086 | 15.4 | 0 | 10.1 s in 136 s (about 7%) | 100 MB | 114 / 780 ms |
| B | 1,000 (4 generator processes x 250) | 30 s + 60 s | 5 s | 672 | about 2,300 | about 24 | 330 failed handshakes | 7.7 s | 115 MB | 930 / 3,676 ms |

Client-side latency in ms (p50 / p95 / p99):

| Metric | A: 200 users | C: 1,000, 5 s calls | D: 1,000, 30 s calls |
|---|---|---|---|
| connect (handshake) | 11.5 / 116 / 256 | 102 / 2,924 / 4,854 | 19.3 / 458 / 690 |
| hello ack | 1.5 / 19 / 51 | 5.0 / 146 / 348 | 3.1 / 130 / 258 |
| queued to match:found | 1 / 270 / 762 | 0 / 24 / 219 | 2 / 197 / 467 |
| match:found to call:start | 4.9 / 62 / 200 | 30 / 363 / 681 | 2.2 / 59 / 189 |
| offer to answer | 3.8 / 63 / 245 | 44 / 524 / 971 | 2.9 / 70 / 314 |
| signal relay round trip | 2.6 / 60 / 283 | 27 / 382 / 1,007 | 1.8 / 59 / 305 |
| chat ack | 1.3 / 19 / 179 | 11 / 166 / 286 | 0.7 / 14 / 111 |

Match latency includes the 500 ms sweeper pass and the pair block after a
skip (two users who just skipped each other wait for someone new).

**Reading the numbers.**

- 1,000 sockets on one process used about 100 to 150 MB of memory and well
  under one core, even at 68 new calls per second (run C), which is far more
  churn than real users produce. With 30 s calls (run D) every median was
  under 20 ms.
- Run B is a failure we want to remember: four generator processes starting
  at once on a saturated machine pushed connection attempts past what the
  starved server could accept. macOS caps the accept backlog at 128
  (`kern.ipc.somaxconn`), so handshakes failed with `websocket error` and
  timeouts. Linux on EC2 has a much larger backlog (`net.core.somaxconn`
  4096 on current kernels), but the lesson holds: watch connection errors
  during deploys and reconnect storms, not just steady state.
- Nothing here measures the gateway, Redis (the `lock:match` global lock),
  the session gate (Turnstile siteverify and token signing), or several
  replicas.

## Still to do before launch (LB-12 exit criterion)

1. Run on the staging EC2 stack (`docker compose`, 2 replicas, Redis, the
   gateway), with the generator on a different machine, ideally in the same
   region as real users:
   ```sh
   # target .env: TURNSTILE_DISABLED=true, MAX_CONNECTIONS_PER_IP=100000, session buckets raised
   node scripts/loadtest/loadtest.ts --url https://staging-api.example.com --users 3000 --ramp 120 --duration 600 --hold 60000 --json lt-3000.json
   ```
   Split the generator across processes or machines when its loop lag p99
   goes above about 50 ms, and raise its `ulimit -n` and local port range.
2. A 2 hour soak at 1,000 sockets (`--duration 7200`), watching backend RSS
   and `nodejs_eventloop_lag_p99_seconds` on `/metrics` for leaks.
3. Record both results in this file with the machine type, and confirm with
   `ss -s` on the host that the gateway and backend did not hit the nofile
   limit (65535 in docker-compose.yml).

## Limits configured for capacity

| Where | Setting | Value |
|---|---|---|
| gateway and frontend nginx | `worker_connections` / `worker_rlimit_nofile` | 16384 / 65535 |
| docker-compose.yml | `ulimits.nofile` for backend, gateway, frontend | 65535 |
| gateway | websocket `proxy_read_timeout` | 1 h (Socket.IO pings every 20 s) |
| backend | `MAX_CONNECTIONS_PER_IP` | 10 per instance (raise only for tests) |
| backend | Socket.IO `maxHttpBufferSize` | 256 KB |
