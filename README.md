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
| 3 | Booking concurrency engine | ✅ `create_booking` RPC, `src/server/bookings`, availability grid, realtime slots, see [docs/architecture/03-booking-engine.md](docs/architecture/03-booking-engine.md) |
| 4 | Real-time chat engine | ✅ gapless seq/rev ordering, idempotent sends, Broadcast hints, sync engines, blocks, reports, media lifecycle, see [docs/architecture/04-chat-engine.md](docs/architecture/04-chat-engine.md) |
| 5 | Mobile-first UI | ⏳ |

## Repository layout

```
supabase/
  migrations/          ordered SQL migrations (schema, RLS, storage, realtime, jobs)
  functions/           Edge Functions (purge-chat-media: scheduled Storage cleanup)
  seed.sql             dev-only location fixture (placeholder PSGC codes)
src/
  db/                  generated database types (npm run db:types) + aliases
  domain/              Zod schemas, mappers, pricing/slot mirrors, availability grid, chat state, error mapping (+ unit tests)
  server/              transport (retries) + server actions over supabase-js (server-only)
    bookings/          booking engine actions
    chat/              chat engine actions
  client/              Realtime subscriptions (court slots, chat), channel budget, chat sync engines
tests/
  db/                  SQL test suite + Supabase shim + concurrency races
  contract/            Zod ↔ Postgres contract tests
  integration/         server actions through a real PostgREST 13 with JWTs and RLS
scripts/               verify-db.sh, gen-db-types.sh, fetch-postgrest.sh, post-deploy-check.sql
docs/architecture/     design notes per step
```

## Checks

```bash
npm ci
npm run check                      # typecheck + format + 329 unit tests

# Database (any Postgres 15+ superuser)
export PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
npm run db:verify                  # migrations + SQL suite + 16 concurrency races (480 checks)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rackethub_test npm run db:types:check
PGDATABASE=rackethub_test npm run test:contract   # 82 Zod ↔ Postgres contract tests

# Server actions through a real PostgREST 13 (downloads a pinned, checksum-verified binary)
npm run postgrest:fetch
PGDATABASE=rackethub_test npm run test:integration   # 62 integration tests
```

`db:verify` drops and recreates the `rackethub_test` database (override with
`RH_TEST_DB`). CI (`.github/workflows/ci.yml`) runs all of the above on
Postgres 15 and 17. After deploying to a Supabase project, run
`scripts/post-deploy-check.sql` against it, and schedule the chat media
purge (see [04-chat-engine.md §14](docs/architecture/04-chat-engine.md#14-operations)).
