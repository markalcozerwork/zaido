/**
 * Integration-test support: supabase-js clients that act as real users
 * (HS256 JWTs signed with the secret PostgREST trusts), plus committed fixtures
 * created through a superuser connection.
 *
 * Unlike the contract tests, these can't run inside a rolled-back transaction:
 * PostgREST uses its own connections. So every fixture is namespaced with fresh
 * UUIDs, and tests never depend on each other's data.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { inject } from "vitest";
import type { Database } from "../../src/db";
import type { DbClient } from "../../src/server/db-client";

const FAKE_SUPABASE_URL = "http://supabase.test";

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ aud: "authenticated", iat: now, exp: now + 3600, ...claims }));
  const signature = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

/**
 * supabase-js calls `${url}/rest/v1/...`; PostgREST serves at its root. A
 * fetch wrapper rewrites the prefix, so no proxy is needed.
 */
function postgrestFetch(postgrestUrl: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.replace(`${FAKE_SUPABASE_URL}/rest/v1`, postgrestUrl), init);
  };
}

export interface ClientOptions {
  /** Wrap the transport, e.g. to simulate a response lost on a flaky mobile network. */
  wrapFetch?: (f: typeof fetch) => typeof fetch;
  /** Sign a token that expired a minute ago (an app resumed after the session lapsed). */
  expired?: boolean;
}

/** A supabase-js client signed in as `userId`, or anonymous when null. */
export function clientAs(userId: string | null, opts: ClientOptions = {}): DbClient {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const jwt = signJwt(
    {
      ...(userId ? { sub: userId, role: "authenticated" } : { role: "anon" }),
      ...(opts.expired ? { iat: past, exp: past + 60 } : {}),
    },
    inject("jwtSecret"),
  );
  const base = postgrestFetch(inject("postgrestUrl"));
  return createClient<Database>(FAKE_SUPABASE_URL, jwt, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: opts.wrapFetch ? opts.wrapFetch(base) : base,
      headers: { Authorization: `Bearer ${jwt}` },
    },
  });
}

/**
 * The request reaches the server and commits, but the client never sees the
 * response (the first `times` matching calls throw like a dropped connection).
 */
export function loseResponses(match: (url: string) => boolean, times = 1) {
  const state = { lost: 0, calls: 0 };
  const wrap =
    (f: typeof fetch): typeof fetch =>
    async (input, init) => {
      const res = await f(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!match(url)) return res;
      state.calls++;
      if (state.lost < times) {
        state.lost++;
        await res.arrayBuffer();
        throw new TypeError("fetch failed");
      }
      return res;
    };
  return { wrap, state };
}

// -----------------------------------------------------------------------------
// Superuser fixtures (committed)
// -----------------------------------------------------------------------------
export const admin = new pg.Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : { max: 5 },
);

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(text, params)).rows as T[];
}

/** PSGC rows in a reserved 97xxxxxxxx range, independent of seed.sql. */
export const LOC = { region: "9700000000", municipality: "9700100000", barangay: "9700100001" } as const;

export async function ensureLocations() {
  await sql(
    `insert into public.ph_regions (code, name) values ($1, 'Integration Region') on conflict do nothing`,
    [LOC.region],
  );
  await sql(
    `insert into public.ph_municipalities (code, region_code, name, is_city) values ($1, $2, 'Integration City', true) on conflict do nothing`,
    [LOC.municipality, LOC.region],
  );
  await sql(
    `insert into public.ph_barangays (code, municipality_code, name) values ($1, $2, 'Brgy. Integration') on conflict do nothing`,
    [LOC.barangay, LOC.municipality],
  );
}

export async function createUser(name = "Integration User"): Promise<string> {
  const id = randomUUID();
  await sql(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id,
    `it-${id}@example.ph`,
    JSON.stringify({ full_name: name }),
  ]);
  return id;
}

export interface VenueFixture {
  venueId: string;
  courtId: string;
  ownerId: string;
}

/**
 * A venue (GCash + cash, auto-confirm cash), one pickleball court (₱400/h, lights
 * ₱100/h from 18:00, 30-minute increments, 60–240 min), weeknight peak ₱600,
 * weekend ₱700, open 06:00–24:00 daily.
 */
export interface VenueOptions {
  timezone?: string;
  /** false = no opening hours rows; an array = these windows instead of 06:00–24:00 daily. */
  hours?: boolean | Array<{ day_of_week: number; opens_at: string; closes_at: string }>;
  /** Extra venue columns (verification_status, min_lead_minutes, is_open_24h, …). */
  venue?: Record<string, unknown>;
  /** Extra court columns (slot_increment_minutes, …). */
  court?: Record<string, unknown>;
}

export async function createVenue(overrides: VenueOptions = {}): Promise<VenueFixture> {
  await ensureLocations();
  const ownerId = await createUser("Venue Owner");
  const venueId = randomUUID();
  const courtId = randomUUID();
  await sql(
    `insert into public.venues (id, owner_id, name, municipality_code, barangay_code, address, gcash_account_name, gcash_number, timezone)
     values ($1, $2, $3, $4, $5, '1 Integration Street', 'Owner', '+639170000001', $6)`,
    [
      venueId,
      ownerId,
      `Venue ${venueId.slice(0, 8)}`,
      LOC.municipality,
      LOC.barangay,
      overrides.timezone ?? "Asia/Manila",
    ],
  );
  if (overrides.venue) await updateRow("venues", venueId, overrides.venue);
  await sql(
    `insert into public.courts (id, venue_id, name, sport, surface_type, hourly_rate, lights_fee_per_hour)
     values ($1, $2, 'Court 1', 'PICKLEBALL', 'ACRYLIC', 400, 100)`,
    [courtId, venueId],
  );
  if (overrides.court) await updateRow("courts", courtId, overrides.court);
  await sql(
    `insert into public.court_rate_rules (court_id, label, days_of_week, start_time, end_time, hourly_rate, priority) values
       ($1, 'Weeknight peak', '{1,2,3,4,5}', '17:00', '22:00', 600, 10),
       ($1, 'Weekend', '{0,6}', '00:00', '24:00', 700, 20)`,
    [courtId],
  );
  if (Array.isArray(overrides.hours)) {
    for (const h of overrides.hours) {
      await sql(
        `insert into public.venue_operating_hours (venue_id, day_of_week, opens_at, closes_at) values ($1, $2, $3, $4)`,
        [venueId, h.day_of_week, h.opens_at, h.closes_at],
      );
    }
  } else if (overrides.hours !== false) {
    await sql(
      `insert into public.venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
       select $1, d, '06:00', '24:00' from generate_series(0, 6) d`,
      [venueId],
    );
  }
  return { venueId, courtId, ownerId };
}

/** Superuser UPDATE of a few columns (trusted context: the guards' player rules don't apply). */
export async function updateRow(table: string, id: string, values: Record<string, unknown>) {
  const cols = Object.keys(values);
  await sql(`update public.${table} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`, [
    id,
    ...cols.map((c) => values[c]),
  ]);
}

/** A verified pickleball coach (₱800/h), optionally with weekly availability windows. */
export async function createCoach(
  windows: Array<{ day_of_week: number; start_time: string; end_time: string }> = [],
  opts: { sports?: string; offersPrivate?: boolean } = {},
): Promise<string> {
  const id = await createUser("Integration Coach");
  await sql(
    `insert into public.coach_profiles (profile_id, sports_coached, hourly_rate, verified_status, offers_private, offers_group_clinics)
     values ($1, $2, 800, 'VERIFIED', $3, true)`,
    [id, opts.sports ?? "{PICKLEBALL}", opts.offersPrivate ?? true],
  );
  for (const w of windows) {
    await sql(
      `insert into public.coach_availability (coach_id, day_of_week, start_time, end_time) values ($1, $2, $3, $4)`,
      [id, w.day_of_week, w.start_time, w.end_time],
    );
  }
  return id;
}

/** An uploaded receipt object (Supabase Storage row) in the booking's own folder. */
export async function uploadReceipt(bookingId: string, file = "gcash.png"): Promise<string> {
  const name = `${bookingId}/${file}`;
  await sql(`insert into storage.objects (bucket_id, name) values ('payment-receipts', $1)`, [name]);
  return name;
}

/** A unique, valid 13-digit GCash reference. */
let refSeq = 0;
export const gcashRef = (): string =>
  `9${String(Date.now() % 1e9).padStart(9, "0")}${String(++refSeq % 1000).padStart(3, "0")}`;
