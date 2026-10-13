import { describe, expect, it, vi } from "vitest";
import { isTransientError } from "../../domain";
import type { DbClient } from "../db-client";
import { createBooking, toCreateArgs } from "./create";
import { callWithRetry, type PostgrestResponseLike } from "./transport";

type Res = PostgrestResponseLike<unknown>;
const ok = (data: unknown): Res => ({ data, error: null, status: 200 });
const fail = (status: number, code: string, message = "x", hint?: string): Res => ({
  data: null,
  error: { code, message, details: null, hint: hint ?? null },
  status,
});
const network = (): Res => fail(0, "", "TypeError: fetch failed");

/** Deterministic retry options: no real waiting, max jitter, a fake clock. */
function fakeTiming() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 1,
      clock: () => t,
    },
  };
}

describe("isTransientError", () => {
  it.each([
    [{ status: 0, code: "" }, true],
    [{ code: "" }, true],
    [{ status: 502, code: "" }, true],
    [{ status: 503, code: "PGRST002" }, true],
    [{ status: 504, code: "PGRST003" }, true],
    [{ status: 520, code: "" }, true],
    [{ status: 409, code: "40001" }, true],
    [{ status: 409, code: "40P01" }, true],
    [{ status: 409, code: "23P01" }, false],
    [{ status: 400, code: "23514" }, false],
    [{ status: 403, code: "42501" }, false],
    [{ status: 401, code: "PGRST301" }, false],
  ])("%j → %s", (err, expected) => {
    expect(isTransientError(err)).toBe(expected);
  });
});

describe("callWithRetry", () => {
  it("retries transient failures with full-jitter exponential backoff, then succeeds", async () => {
    const { sleeps, opts } = fakeTiming();
    const responses = [network(), fail(503, "PGRST003"), fail(409, "40P01"), ok({ id: 1 })];
    const op = vi.fn(async () => responses.shift()!);
    expect(await callWithRetry(op, opts)).toEqual({ ok: true, data: { id: 1 } });
    expect(op).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([200, 400, 800]);
  });

  it("does not retry real answers", async () => {
    const op = vi.fn(async () =>
      fail(409, "23P01", 'conflicting key value violates exclusion constraint "bookings_no_court_overlap"'),
    );
    const res = await callWithRetry(op, fakeTiming().opts);
    expect(op).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, error: { code: "SLOT_TAKEN", retryable: false } });
  });

  it("gives up after maxAttempts with a retryable error", async () => {
    const op = vi.fn(async () => network());
    const res = await callWithRetry(op, { ...fakeTiming().opts, maxAttempts: 3 });
    expect(op).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ ok: false, error: { code: "RETRYABLE", retryable: true } });
  });

  it("gives up when the next wait would exceed the time budget", async () => {
    const op = vi.fn(async () => network());
    const res = await callWithRetry(op, { ...fakeTiming().opts, budgetMs: 500 });
    // waits 200 (t=200), next wait 400 would end at 600 > 500
    expect(op).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: false, error: { code: "RETRYABLE" } });
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    const op = vi.fn(async () => {
      controller.abort();
      return network();
    });
    const res = await callWithRetry(op, { ...fakeTiming().opts, signal: controller.signal });
    expect(op).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, error: { code: "ABORTED" } });
  });

  it("treats a thrown error as no response", async () => {
    const responses: Array<() => Res> = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => ok([]),
    ];
    const op = vi.fn(async () => responses.shift()!());
    expect(await callWithRetry(op, fakeTiming().opts)).toEqual({ ok: true, data: [] });
  });

  it("passes an AbortSignal that fires when the budget is spent", async () => {
    let seen: AbortSignal | undefined;
    const op = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<Res>((resolve) => signal.addEventListener("abort", () => resolve(network())));
    };
    const res = await callWithRetry(op, { budgetMs: 20, maxAttempts: 1 });
    expect(seen?.aborted).toBe(true);
    expect(res).toMatchObject({ ok: false, error: { code: "RETRYABLE" } });
  });
});

// -----------------------------------------------------------------------------
// createBooking against a fake PostgREST client
// -----------------------------------------------------------------------------
function fakeRpcClient(responses: Res[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const builder = {
        abortSignal: () => builder,
        retry: () => builder,
        then: (resolve: (r: Res) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(responses.shift() ?? network()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as DbClient, calls };
}

const NOW = new Date("2026-10-13T00:00:00Z");
const request = {
  court_id: "20000000-0000-4000-a000-000000000001",
  start_time: "2026-10-19T10:00:00Z",
  end_time: "2026-10-19T11:00:00Z",
  payment_method: "GCASH",
  idempotency_key: "aaaaaaaa-0000-4000-a000-000000000001",
};
const row = (over: Record<string, unknown> = {}) => ({
  id: "30000000-0000-4000-a000-000000000001",
  booking_status: "PENDING_PAYMENT",
  payment_status: "UNPAID",
  cancellation_reason: null,
  ...over,
});

describe("createBooking", () => {
  const deps = { now: () => NOW, retry: fakeTiming().opts };

  it("sends only the given arguments (omitted, never null) with the checkout key", async () => {
    const { client, calls } = fakeRpcClient([ok(row())]);
    const res = await createBooking(client, request, deps);
    expect(res).toMatchObject({ ok: true, data: { id: "30000000-0000-4000-a000-000000000001" } });
    expect(calls).toEqual([
      {
        fn: "create_booking",
        args: {
          p_court_id: request.court_id,
          p_start: "2026-10-19T10:00:00.000Z",
          p_end: "2026-10-19T11:00:00.000Z",
          p_payment_method: "GCASH",
          p_idempotency_key: request.idempotency_key,
        },
      },
    ]);
  });

  it("survives a lost response: the retry carries the same key and gets the same booking", async () => {
    const { client, calls } = fakeRpcClient([network(), ok(row())]);
    const res = await createBooking(client, request, deps);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.p_idempotency_key).toBe(calls[0]!.args.p_idempotency_key);
  });

  it("maps the database's typed refusals", async () => {
    const { client } = fakeRpcClient([
      fail(
        409,
        "23P01",
        "SLOT_ALREADY_YOURS: You already have this court at that time.",
        "30000000-0000-4000-a000-000000000009",
      ),
    ]);
    expect(await createBooking(client, request, deps)).toEqual({
      ok: false,
      error: {
        code: "SLOT_ALREADY_YOURS",
        message: "You already have this court at that time.",
        field: "start_time",
        retryable: false,
        cause: "23P01",
        meta: { bookingId: "30000000-0000-4000-a000-000000000009" },
      },
    });
  });

  it("a replay of a checkout whose hold expired says HOLD_EXPIRED, not success", async () => {
    const { client } = fakeRpcClient([
      ok(row({ booking_status: "CANCELLED", cancellation_reason: "PAYMENT_WINDOW_EXPIRED" })),
    ]);
    expect(await createBooking(client, request, deps)).toMatchObject({
      ok: false,
      error: { code: "HOLD_EXPIRED" },
    });
  });

  it("rejects malformed input before calling the database (no key, client-sent amounts, off-grid times)", async () => {
    const { client, calls } = fakeRpcClient([]);
    const { idempotency_key: _key, ...noKey } = request;
    for (const bad of [
      noKey,
      { ...request, total_amount: 1 },
      { ...request, start_time: "2026-10-19T10:05:00Z" },
    ]) {
      expect((await createBooking(client, bad, deps)).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("toCreateArgs drops undefined optionals", () => {
    expect(
      Object.keys(
        toCreateArgs({
          ...request,
          payment_method: "GCASH",
          coach_id: undefined,
          notes: undefined,
        }),
      ),
    ).toEqual(["p_court_id", "p_start", "p_end", "p_payment_method", "p_idempotency_key"]);
  });
});
