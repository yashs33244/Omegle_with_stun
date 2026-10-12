/**
 * Instance-wide limits and overload shedding (shed/LoadMonitor.ts,
 * shed/Shedder.ts). Every other limit is per client IP, session or socket;
 * these bound what all clients together may cost one process, so a crowd of
 * addresses degrades new arrivals instead of the calls already running.
 */
import { SECOND_MS } from "../session/constants";

/** How often LoadMonitor samples the event loop and the heap. */
export const LOAD_SAMPLE_INTERVAL_MS = SECOND_MS;
/** Event-loop delay histogram resolution (perf_hooks.monitorEventLoopDelay). */
export const LOOP_DELAY_RESOLUTION_MS = 10;

/**
 * A sample is hot when the loop delay p99 over the last interval is above
 * this, or the heap is above HEAP_OVER_RATIO of its limit. 200 ms of delay
 * means every relayed rtc:signal and chat message waits that long.
 */
export const LOOP_DELAY_OVER_MS = 200;
export const HEAP_OVER_RATIO = 0.8;
/** Consecutive hot samples before the instance counts as overloaded (one GC pause is not overload). */
export const OVER_SAMPLES = 2;

/**
 * Hysteresis: an overloaded instance recovers only after CLEAR_SAMPLES
 * consecutive samples below these lower marks, so refusals do not flap on
 * and off around a single threshold.
 */
export const LOOP_DELAY_CLEAR_MS = 100;
export const HEAP_CLEAR_RATIO = 0.7;
export const CLEAR_SAMPLES = 5;

/**
 * Without SHED_HEAP_LIMIT_MB the heap limit is V8's heap_size_limit, capped
 * at this share of the container's memory (process.constrainedMemory) when
 * the process runs under a cgroup limit: V8 sizes its heap from the host's
 * memory, not the container's, and the rest of the RSS (sockets, buffers,
 * code) needs room too. 512 MB container: 307 MB limit, shedding from 246 MB.
 */
export const HEAP_SHARE_OF_MEMORY = 0.6;

/**
 * The instance-wide POST /api/session bucket holds this many seconds of
 * SESSION_RATE_TOTAL_PER_SEC, so a short spike of real arrivals is absorbed.
 */
export const SESSION_TOTAL_BURST_SECONDS = 5;

/**
 * Retry-After (seconds) on every shed refusal. Overload clears after
 * CLEAR_SAMPLES calm seconds at the earliest; clients back off past this.
 */
export const SHED_RETRY_AFTER_SEC = 10;
