# RacketHub

Hyperlocal racket-sports community and court-booking platform for the
Philippines: pickleball, badminton, tennis and table tennis at the barangay
and municipality level.

**Stack:** Supabase (PostgreSQL + RLS, Realtime, Storage) · TypeScript + Zod ·
mobile-first client (Next.js PWA or Flutter).

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Database architecture & migrations | ✅ `supabase/migrations`, see [docs/architecture/01-database.md](docs/architecture/01-database.md) |
| 2 | TypeScript models & Zod schemas | ⏳ |
| 3 | Booking concurrency engine | ⏳ |
| 4 | Real-time chat engine | ⏳ |
| 5 | Mobile-first UI | ⏳ |

## Repository layout

```
supabase/
  migrations/        ordered SQL migrations (schema, RLS, storage, realtime, jobs)
  seed.sql           dev-only location fixture (placeholder PSGC codes)
tests/db/            database test suite + Supabase shim + concurrency races
scripts/verify-db.sh apply all migrations to a scratch DB and run the suite
docs/architecture/   design notes per step
```

## Database checks

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres scripts/verify-db.sh
```

This drops and recreates the `rackethub_test` database (override with
`RH_TEST_DB`), applies every migration, and runs 167 assertions, including
real parallel-session races for double-booking and event capacity. CI runs it
on Postgres 15 and 17 (`.github/workflows/database.yml`).
