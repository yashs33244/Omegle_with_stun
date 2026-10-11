# Engineering conventions (backend)

How `backend/src` is laid out and the patterns it already uses. Nothing here
is aspirational: every rule points at code that follows it.

## Module boundaries

| module | owns | talks to |
|---|---|---|
| `protocol.ts` | wire types, zod schemas, flags schema and defaults. Source of truth; copied to the frontend by `scripts/sync-protocol.sh` | nothing |
| `config.ts` | every env-driven value (`loadConfig`) | protocol |
| `store/` | `MatchStore` contract + `MemoryStore` / `RedisStore` (sessions, rooms, queue, coins, bans, instances) | protocol |
| `match/` | `MatchService`: the state machine behind every socket event | store, flags, safety, turn, enforcement, session (queue gate) |
| `realtime/` | Socket.IO wiring, rate limiting per socket, the Redis adapter | match, session (handshake), rateLimit |
| `http/` | Express routers: public, session, admin, health | match, enforcement, flags, session |
| `session/` | POST /api/session gate, tokens, lockouts, caps, handshake, queue gate | flags, store (stats only) |
| `enforcement/` | reports, restrictions, appeals, takedowns, evidence, audit, retention | protocol, session (Turnstile) |
| `safety/` | chat/name guard and soft abuse signals | protocol |
| `turn/` | per-call ICE servers, credential caps, the TURN spend cap | config, flags |
| `flags/` | operator flags store + cached reader | protocol |
| `rateLimit.ts`, `metrics.ts`, `logger.ts` | shared primitives | nothing in `src/` except `match/matchMetrics` |

Imports go downwards in that table: a lower module never imports `match/`,
`realtime/` or `http/`. When a lower module needs something from above it
declares an interface and the caller implements it (`RestrictionSink` in
enforcement, implemented by `MatchService`; `RestrictionChecker` in session,
implemented by enforcement).

## Constants rule

Every number or string that is a tuning value, a limit, a TTL, a key prefix,
a metric label or a message lives in the module's `constants.ts`
(`src/<module>/constants.ts`) with a one-line comment giving the unit and the
reason. Root-level files (`rateLimit.ts`) keep theirs at the top of the file.
Three exceptions:

- Env-driven values are config, not constants: if an operator may change it
  per deployment it goes in `config.ts` (and `.env.example`, README). Do not
  duplicate a config field as a constant.
- Operator-tunable-at-runtime values are flags (`FLAG_DEFAULTS` in protocol).
- Wire-visible vocabularies (reasons, error codes, event names) live in
  `protocol.ts` so both ends share them.

Time units are spelled out per module (`MINUTE`, `HOUR`, `DAY`, `YEAR` in
enforcement; `SECOND_MS`, `HOUR_MS`, `DAY_MS` in turn and session) rather
than one global file: each module reads on its own.

## Enums as const

No TypeScript `enum`. A vocabulary is an `as const` array or object and the
type is derived from it:

```ts
export const COLLECTIONS = ["report", "restriction", "appeal", "takedown", "audit"] as const;
export type Collection = (typeof COLLECTIONS)[number];

export const CREDENTIAL_RESULT = { disabled: "disabled", cached: "cached", issued: "issued" } as const;
export type CredentialResult = (typeof CREDENTIAL_RESULT)[keyof typeof CREDENTIAL_RESULT];
```

Use an array when the set is iterated or validated (`GENDER_FILTERS`,
`EVENT_CLASSES`); use an object when call sites name members
(`AUDIT_ACTION.autoPause`, `SPEND_STEP.turnOff`). The runtime string never
changes when a member is renamed, so stored data and metric labels stay stable.
Subsets of a protocol union are checked with `satisfies`
(`HANDSHAKE_REJECT_CODES`). Discriminators of small tagged unions
(`kind: "session" | "age"`) stay literal.

## Patterns in use

- **Strategy (store backends, TURN providers).** One interface, two or more
  implementations chosen at boot: `MatchStore` -> `MemoryStore` | `RedisStore`;
  `EnforcementStore` -> `MemoryEnforcementStore` | `RedisEnforcementStore`;
  `SessionKv` -> `MemoryKv` | `RedisKv`; `TurnStore`, `SignalStore`,
  `FlagsStore`, `EvidenceStore` (fs | S3) likewise; `TurnService.generate`
  picks cloudflare | coturn by `config.turnProvider`. Layout: the contract in
  `<Name>.ts`, each backend in `Memory<Name>.ts` / `Redis<Name>.ts`; small
  stores (`turn/store.ts`, `safety/signals.ts`) keep all three in one file
  while they fit on one screen. Memory and Redis must behave the same: one
  contract test runs against both (`test/storeContract.ts`,
  `test/unit/enforcementStore.test.ts`).
- **Dependency injection via `deps` objects.** Services take one `deps`
  argument with their collaborators and optional seams: `fetch`, `now`,
  `logger`, `metrics`, `redis`. Production passes real ones; tests pass fakes.
  Never call `Date.now()` or global `fetch` directly in a service: read
  `this.now()` / `deps.fetch`. Pure helpers (`policy.ts`, `geo.ts`) take `now`
  as a parameter instead.
- **Emitter over Socket.IO.** `MatchService` never touches a socket; it emits
  through the `Emitter` interface keyed by socket id, which `realtime/socket.ts`
  implements and which works across instances through the Redis adapter.
- **Reader/cache.** `FlagsReader` caches `FlagsStore.get()` per instance and
  refreshes on a timer; hot paths call the synchronous `current()`.
  `SafetySignals.lowPriority()` is the same shape with a 1 s cache.
- **Token bucket.** `rateLimit.ts`: one bucket per event class per socket,
  continuous refill, `full()` tells the sweeper when a bucket can be dropped.
- **Audit log is append-only.** `EnforcementService.audit()` only `put`s new
  entries under `AUDIT_ACTION` names; nothing updates or deletes them except
  the retention sweep after `RETENTION_MS`.
- **Fail closed / fail open, by design.** Security checks fail closed
  (Turnstile, tokens, lockouts). Niceties fail open with a warning log
  (match caps, low priority, TURN credentials -> STUN only).

## Error codes

- Socket acks and `server:error` use `ErrorCode` from `protocol.ts`; HTTP
  bodies use the response's own `error` union (`SessionError`,
  `AppealResponse`, ...) mapped to a status in one table
  (`SESSION_ERROR_STATUS`, `http/admin.ts`).
- Codes are `snake_case` strings, never numbers, never free text. A new
  code is added to the protocol union with a comment, then the frontend copy
  is synced.
- Admin operations return `AdminResult<T>` (`{ ok, value } | { ok, error }`)
  with `AdminError`; services never throw for expected outcomes.
- Logs carry `err` objects and ids, never names, chat, photos or IPs
  (`logger.ts` header).

## Store method or service method?

Add a **store method** when the operation must be atomic or indexed in the
backend (a `MULTI`, a sorted-set range, a conditional set) or when memory and
Redis need different code. Keep it dumb: no business rules, no logging,
values copied in and out. Add a **service method** for everything else:
composing store calls, applying policy, emitting events, metrics. If a
service method needs `withLock()` around two store calls, that is a hint the
store wants one atomic method instead.

## Test layering

| layer | where | runs against | run with |
|---|---|---|---|
| unit | `backend/test/unit/*.test.ts` | pure functions, services with fakes, store contracts (memory and, when `REDIS_URL` is set, Redis) | `bun test` |
| integration | `backend/test/integration/*.test.ts` | a real server on port 0 with socket.io clients, memory store | `bun test`; `TEST_STORE=redis bun test` re-runs them on Redis |
| node | `backend/test-node/*.mjs` | the built `dist/` under Node 22 (what production runs) | `bun run build && bun run test:node` |
| e2e | `new-frontend/e2e/**` (Playwright) | the real frontend against the real backend | `npm run test:e2e` |
| stack | CI "Compose stack" job | the docker-compose production stack | CI only |

New rules get a unit test next to the rule; new socket or HTTP behaviour
gets an integration test; a store method gets a contract case so both
backends prove it.

## How to add a feature

1. Wire shape first: edit `backend/src/protocol.ts` (events, schemas, error
   codes, flags), run `scripts/sync-protocol.sh`, commit both copies.
2. New tunables: operator-changeable at runtime -> a flag (`FLAG_DEFAULTS` +
   `flagsSchema`); per-deployment -> `config.ts` + `backend/.env.example` +
   the README env table (`scripts/check-deploy-env.sh` keeps compose and the
   deploy in step); fixed -> the module's `constants.ts`.
3. Storage: extend the store contract, implement memory and Redis, add a
   contract test case.
4. Service logic behind a `deps` object; policy as pure functions.
5. Tests per layer above; locales and e2e testids on the frontend side.
6. Before pushing: `bun run typecheck && bun run lint && bun test &&
   bun run build && bun run test:node`, `scripts/sync-protocol.sh --check`,
   `scripts/check-lockfiles.sh` (lockfiles must point at the public registry).
7. Docs: README rows for new env/flags, `docs/` runbook if operators act on it.
