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

/** A supabase-js client signed in as `userId`, or anonymous when null. */
export function clientAs(userId: string | null): DbClient {
  const jwt = signJwt(
    userId ? { sub: userId, role: "authenticated" } : { role: "anon" },
    inject("jwtSecret"),
  );
  return createClient<Database>(FAKE_SUPABASE_URL, jwt, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: postgrestFetch(inject("postgrestUrl")), headers: { Authorization: `Bearer ${jwt}` } },
  });
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
export async function createVenue(
  overrides: { timezone?: string; hours?: boolean } = {},
): Promise<VenueFixture> {
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
  await sql(
    `insert into public.courts (id, venue_id, name, sport, surface_type, hourly_rate, lights_fee_per_hour)
     values ($1, $2, 'Court 1', 'PICKLEBALL', 'ACRYLIC', 400, 100)`,
    [courtId, venueId],
  );
  await sql(
    `insert into public.court_rate_rules (court_id, label, days_of_week, start_time, end_time, hourly_rate, priority) values
       ($1, 'Weeknight peak', '{1,2,3,4,5}', '17:00', '22:00', 600, 10),
       ($1, 'Weekend', '{0,6}', '00:00', '24:00', 700, 20)`,
    [courtId],
  );
  if (overrides.hours !== false) {
    await sql(
      `insert into public.venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
       select $1, d, '06:00', '24:00' from generate_series(0, 6) d`,
      [venueId],
    );
  }
  return { venueId, courtId, ownerId };
}
