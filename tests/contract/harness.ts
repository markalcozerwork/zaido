/**
 * Contract-test harness: a real Postgres with `supabase/migrations` applied
 * (e.g. the database left behind by scripts/verify-db.sh).
 *
 * Every test runs inside one transaction that is ROLLED BACK, so tests never
 * leave data behind and can run against any disposable database. Each attempt
 * runs inside a SAVEPOINT, so an expected failure doesn't abort the
 * transaction.
 *
 * Connection: DATABASE_URL, or the standard PGHOST/PGPORT/PGUSER/PGDATABASE.
 * Needs a superuser-like role (it creates fixtures and switches to
 * `authenticated`).
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, afterEach } from "vitest";

export type Outcome =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; code: string; message: string; constraint?: string };

export interface Db {
  /** Run SQL inside a savepoint and report success or the Postgres error. */
  attempt(sql: string, params?: unknown[]): Promise<Outcome>;
  /** Like attempt, but always rolls the statement back (pure "would this be accepted?" check). */
  probe(sql: string, params?: unknown[]): Promise<Outcome>;
  /** Run SQL and throw on failure (fixtures). */
  exec<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Act as a signed-in Supabase user (role authenticated + JWT claims). */
  asUser(profileId: string): Promise<void>;
  /** Back to the connecting superuser (trusted context). */
  asAdmin(): Promise<void>;
}

const hasConnectionConfig = Boolean(process.env.DATABASE_URL || process.env.PGHOST || process.env.PGDATABASE);

/** Wires a fresh rolled-back transaction around every test in the calling file. */
export function useContractDb(): Db {
  if (!hasConnectionConfig) {
    throw new Error(
      "Contract tests need a database: set DATABASE_URL or PGHOST/PGDATABASE (see scripts/verify-db.sh).",
    );
  }
  const client = new pg.Client(
    process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
  );
  let sp = 0;

  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("begin");
  });
  afterEach(async () => {
    await client.query("rollback");
  });

  const db: Db = {
    async attempt(sql, params = []) {
      const name = `sp_${++sp}`;
      await client.query(`savepoint ${name}`);
      try {
        const res = await client.query(sql, params);
        await client.query(`release savepoint ${name}`);
        return { ok: true, rows: res.rows };
      } catch (e) {
        await client.query(`rollback to savepoint ${name}`);
        const err = e as pg.DatabaseError;
        return {
          ok: false,
          code: err.code ?? "?",
          message: err.message,
          ...(err.constraint ? { constraint: err.constraint } : {}),
        };
      }
    },
    async probe(sql, params = []) {
      const name = `sp_${++sp}`;
      await client.query(`savepoint ${name}`);
      try {
        const res = await client.query(sql, params);
        return { ok: true, rows: res.rows };
      } catch (e) {
        const err = e as pg.DatabaseError;
        return {
          ok: false,
          code: err.code ?? "?",
          message: err.message,
          ...(err.constraint ? { constraint: err.constraint } : {}),
        };
      } finally {
        await client.query(`rollback to savepoint ${name}`);
      }
    },
    async exec(sql, params = []) {
      return (await client.query(sql, params)).rows;
    },
    async asUser(profileId) {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: profileId, role: "authenticated" }),
      ]);
    },
    async asAdmin() {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims', '', true)");
    },
  };
  return db;
}

export interface Statement {
  sql: string;
  params: unknown[];
}

/** Attempt a statement inside a savepoint. */
export const tryRun = (db: Db, st: Statement) => db.attempt(st.sql, st.params);
/** Check a statement without keeping its effects. */
export const probe = (db: Db, st: Statement) => db.probe(st.sql, st.params);
/** Run a statement and throw on failure (fixtures). */
export const run = (db: Db, st: Statement) => db.exec(st.sql, st.params);

/** First row of a successful statement that used `returning row_to_json(t) as j`. */
export function createdRow<T>(outcome: Outcome): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
  return (outcome.rows[0] as { j: T }).j;
}

/** INSERT built from an object's keys, so omitted columns take their DB default. */
/** `table` is a public table name, or schema-qualified ("storage.objects"). */
export function insertSql(table: string, row: Record<string, unknown>, returning = "*"): Statement {
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`);
  const target = table.includes(".") ? table : `public.${table}`;
  return {
    sql: `insert into ${target} (${cols.map((c) => `"${c}"`).join(", ")}) values (${params.join(", ")}) returning ${returning}`,
    params: Object.values(row),
  };
}

export function updateSql(
  table: string,
  patch: Record<string, unknown>,
  where: Record<string, unknown>,
): Statement {
  const sets = Object.keys(patch).map((c, i) => `"${c}" = $${i + 1}`);
  const offset = sets.length;
  const conds = Object.keys(where).map((c, i) => `"${c}" = $${offset + i + 1}`);
  return {
    sql: `update public.${table} set ${sets.join(", ")} where ${conds.join(" and ")} returning *`,
    params: [...Object.values(patch), ...Object.values(where)],
  };
}

// -----------------------------------------------------------------------------
// Fixtures (created as the superuser inside the test transaction)
// -----------------------------------------------------------------------------
/** Self-contained PSGC rows in a reserved 98xxxxxxxx range (independent of seed.sql). */
export const LOC = {
  region: "9800000000",
  municipality: "9800100000",
  barangay: "9800100001",
  otherMunicipality: "9800200000",
  otherBarangay: "9800200001",
} as const;

export async function seedLocations(db: Db) {
  await db.exec(
    `insert into public.ph_regions (code, name) values ($1, 'Contract Region') on conflict do nothing`,
    [LOC.region],
  );
  await db.exec(
    `insert into public.ph_municipalities (code, region_code, name, is_city) values
       ($1, $3, 'Contract City', true), ($2, $3, 'Other City', true) on conflict do nothing`,
    [LOC.municipality, LOC.otherMunicipality, LOC.region],
  );
  await db.exec(
    `insert into public.ph_barangays (code, municipality_code, name) values
       ($1, $2, 'Brgy. Uno'), ($3, $4, 'Brgy. Dos') on conflict do nothing`,
    [LOC.barangay, LOC.municipality, LOC.otherBarangay, LOC.otherMunicipality],
  );
}

/**
 * A random 13-digit GCash-style reference. Payment refs are globally unique
 * (anti-reuse index), so fixed refs would clash with data already in the DB.
 */
export const uniqueGcashRef = (): string =>
  `9${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;

let userSeq = 0;
/** Gives a user a minimal coach profile (needed before coach_availability rows). */
export async function makeCoach(db: Db, userId: string, sports = "{TENNIS}") {
  await db.exec(
    `insert into public.coach_profiles (profile_id, sports_coached, hourly_rate) values ($1, $2, 500)`,
    [userId, sports],
  );
}

/** Creates an auth user; the sign-up trigger provisions profile + contact rows. */
export async function createUser(db: Db, name = "Contract User"): Promise<string> {
  const [row] = await db.exec<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [`contract-${Date.now()}-${++userSeq}@example.ph`, JSON.stringify({ full_name: name })],
  );
  return row!.id;
}
