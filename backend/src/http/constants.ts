/**
 * Node http server limits (applied in server.ts). Node's defaults let one idle
 * or slow client hold a socket for 5 minutes (requestTimeout 300 s); these
 * values bound every phase of a request so a slowloris or a lying
 * Content-Length costs at most a few seconds of one socket.
 */
import { SECOND_MS } from "../session/constants";

/** A client must finish sending its headers this soon after the first byte. */
export const HTTP_HEADERS_TIMEOUT_MS = 15 * SECOND_MS;
/**
 * Whole request (headers and body) deadline. The gateway proxies REST with a
 * 30 s read timeout (deploy/nginx/gateway.conf), so nothing legitimate takes longer.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 30 * SECOND_MS;
/**
 * How often Node sweeps sockets for the two deadlines above (its default of
 * 30 s would let a stalled request live up to 30 s past its deadline).
 */
export const HTTP_CONNECTIONS_CHECK_INTERVAL_MS = 5 * SECOND_MS;
/**
 * Idle keep-alive sockets are closed after this. It is longer than the
 * gateway's upstream keepalive_timeout (60 s), so the proxy, not the backend,
 * closes an idle connection; a backend-side close would race a new request.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65 * SECOND_MS;
/** More header lines than this is a 431 (the API uses about a dozen). */
export const HTTP_MAX_HEADERS_COUNT = 100;
/** Requests served on one keep-alive socket before it is closed (bounds parser state reuse). */
export const HTTP_MAX_REQUESTS_PER_SOCKET = 1_000;

/** Body caps per router, in bytes (a session request is a few hundred bytes; admin flags are the largest). */
export const SESSION_BODY_LIMIT_BYTES = 8 * 1024;
export const ENFORCEMENT_BODY_LIMIT_BYTES = 16 * 1024;
export const ADMIN_BODY_LIMIT_BYTES = 16 * 1024;
export const BILLING_BODY_LIMIT_BYTES = 8 * 1024;
/** A Razorpay payment.captured event is a few KB; the raw body is kept for the HMAC check. */
export const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
/**
 * The per-instance burst bucket in front of POST /api/session holds this many
 * minutes of SESSION_RATE_PER_IP_PER_MIN and refills at that rate, so the
 * store-backed limit is the one a client meets first.
 */
export const SESSION_BURST_FACTOR = 2;
/**
 * Keys one per-instance IP bucket map (http/public.ts IpBuckets) holds. At the
 * cap the map evicts refilled buckets first, then the fullest of the oldest
 * (rateLimit.ts evictOne): about 100 bytes each, so 5 MB per map at most.
 */
export const IP_BUCKETS_MAX_KEYS = 50_000;
/** Addresses the admin auth-failure map holds (http/admin.ts); lockouts are evicted last. */
export const ADMIN_FAILURES_MAX_KEYS = 10_000;
