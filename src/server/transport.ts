/**
 * One PostgREST call with bounded, jittered retries on transient failures.
 *
 * postgrest-js only retries GET/HEAD/OPTIONS on 503/520, and never the RPC
 * POST that creates a booking. Mobile data in the Philippines drops
 * responses often enough that the booking action has to survive it, and it can:
 * every booking write is idempotent (create_booking replays by key, updates set
 * absolute values), so sending the same request again is always safe.
 *
 * Retried (same request, same idempotency key): no response at all (status 0:
 * network, per-attempt timeout), 502/503/504/520, PostgREST pool/schema-cache
 * errors, and transactions Postgres rolled back (40001, 40P01). Everything
 * else is a real answer and is mapped to a DomainError immediately.
 */
import { isTransientError, mapDatabaseError, type DatabaseErrorLike, type DomainError } from "../domain";

/** What a postgrest-js builder resolves to (the fields we use). */
export interface PostgrestResponseLike<T> {
  data: T | null;
  error: Omit<DatabaseErrorLike, "status"> | null;
  status: number;
}

export interface RetryOptions {
  /** Total wall-clock budget across attempts and waits (ms). */
  budgetMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Caller cancellation (e.g. the HTTP request was aborted). */
  signal?: AbortSignal | undefined;
  // Injection points for tests.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  clock?: () => number;
}

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: DomainError };

export const DEFAULT_RETRY = {
  budgetMs: 10_000,
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
} as const;

const ABORTED: DomainError = { code: "ABORTED", message: "The request was cancelled.", retryable: false };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `op` until it returns data, a non-transient error, or the budget runs
 * out. `op` receives an AbortSignal that fires when the remaining budget is
 * spent (or the caller aborts); pass it to the builder with `.abortSignal()`.
 * Builders should also call `.retry(false)` so postgrest-js doesn't retry
 * inside our budget.
 */
export async function callWithRetry<T>(
  op: (signal: AbortSignal) => PromiseLike<PostgrestResponseLike<T>>,
  options: RetryOptions = {},
): Promise<CallResult<T>> {
  const budgetMs = options.budgetMs ?? DEFAULT_RETRY.budgetMs;
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const clock = options.clock ?? Date.now;
  const caller = options.signal;
  const startedAt = clock();

  for (let attempt = 1; ; attempt++) {
    if (caller?.aborted) return { ok: false, error: ABORTED };

    const remaining = Math.max(1, budgetMs - (clock() - startedAt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const forward = () => controller.abort();
    caller?.addEventListener("abort", forward, { once: true });

    let res: PostgrestResponseLike<T>;
    try {
      res = await op(controller.signal);
    } catch (e) {
      // A builder configured to throw, or a fetch that rejected outright.
      res = {
        data: null,
        error: { code: "", message: e instanceof Error ? e.message : String(e) },
        status: 0,
      };
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", forward);
    }

    if (!res.error) return { ok: true, data: res.data as T };
    if (caller?.aborted) return { ok: false, error: ABORTED };

    const err: DatabaseErrorLike = { ...res.error, status: res.status };
    if (!isTransientError(err)) return { ok: false, error: mapDatabaseError(err) };

    // Full jitter: spreads a burst of retrying clients instead of syncing them.
    const delay = random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    if (attempt >= maxAttempts || clock() - startedAt + delay >= budgetMs) {
      return { ok: false, error: exhausted(err) };
    }
    await sleep(delay);
  }
}

function exhausted(err: DatabaseErrorLike): DomainError {
  const mapped = mapDatabaseError(err);
  if (mapped.code === "RETRYABLE") return mapped;
  return {
    code: "RETRYABLE",
    message: "We couldn't reach RacketHub. Check your connection and try again.",
    retryable: true,
    ...(err.code ? { cause: err.code } : err.status !== undefined ? { cause: `HTTP ${err.status}` } : {}),
  };
}
