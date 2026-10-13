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
| 2 | TypeScript models & Zod schemas | ✅ `src/domain`, see [docs/architecture/02-domain-models.md](docs/architecture/02-domain-models.md) |
| 3 | Booking concurrency engine | ⏳ |
| 4 | Real-time chat engine | ⏳ |
| 5 | Mobile-first UI | ⏳ |

## Repository layout

```
supabase/
  migrations/          ordered SQL migrations (schema, RLS, storage, realtime, jobs)
  seed.sql             dev-only location fixture (placeholder PSGC codes)
src/
  db/                  generated database types (npm run db:types) + aliases
  domain/              Zod schemas, mappers, pricing/slot mirrors, error mapping (+ unit tests)
tests/
  db/                  SQL test suite + Supabase shim + concurrency races
  contract/            Zod ↔ Postgres contract tests
scripts/               verify-db.sh, gen-db-types.sh
docs/architecture/     design notes per step
```

## Checks

```bash
npm ci
npm run check                      # typecheck + format + 156 unit tests

# Database (any Postgres 15+ superuser)
export PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
npm run db:verify                  # migrations + 167 SQL assertions + concurrency races
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rackethub_test npm run db:types:check
PGDATABASE=rackethub_test npm run test:contract   # 62 Zod ↔ Postgres contract tests
```

`db:verify` drops and recreates the `rackethub_test` database (override with
`RH_TEST_DB`). CI (`.github/workflows/ci.yml`) runs all of the above on
Postgres 15 and 17.
