/**
 * Starts a real PostgREST 13 (the API layer in front of every Supabase project)
 * against the test database, the way Supabase runs it: it logs in as
 * `authenticator`, verifies HS256 JWTs and switches to the token's role, so RLS
 * applies exactly as in production.
 *
 * Needs: the migrations applied (scripts/verify-db.sh), PG* env vars, and the
 * binary from scripts/fetch-postgrest.sh (or POSTGREST_BIN).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    postgrestUrl: string;
    jwtSecret: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
}

function databaseUri(): string {
  const db = process.env.PGDATABASE ?? process.env.RH_TEST_DB ?? "rackethub_test";
  const host = process.env.PGHOST ?? "localhost";
  const port = process.env.PGPORT ?? "5432";
  return host.startsWith("/")
    ? `postgresql://authenticator:authenticator@/${db}?host=${encodeURIComponent(host)}&port=${port}`
    : `postgresql://authenticator:authenticator@${host}:${port}/${db}`;
}

export default async function setup(project: TestProject) {
  const bin = process.env.POSTGREST_BIN ?? resolve(import.meta.dirname, "../../.cache/postgrest/postgrest");
  if (!existsSync(bin)) throw new Error(`PostgREST not found at ${bin}. Run scripts/fetch-postgrest.sh.`);

  const jwtSecret = randomBytes(32).toString("hex");
  const port = await freePort();
  const proc = spawn(bin, [], {
    env: {
      PGRST_DB_URI: databaseUri(),
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(port),
      PGRST_DB_POOL: "40",
      PGRST_DB_CHANNEL_ENABLED: "false",
      PGRST_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`PostgREST exited with code ${proc.exitCode}`);
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("PostgREST did not become ready within 20s");
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  project.provide("postgrestUrl", url);
  project.provide("jwtSecret", jwtSecret);

  return async () => {
    proc.kill("SIGTERM");
  };
}
