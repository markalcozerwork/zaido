import { defineConfig } from "vitest/config";

// Integration tests: the server layer through supabase-js → PostgREST 13 → Postgres,
// with real JWTs and RLS. See tests/integration/global-setup.ts.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
