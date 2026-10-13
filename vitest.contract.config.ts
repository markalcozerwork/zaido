import { defineConfig } from "vitest/config";

// Contract tests: run the Zod schemas against a real Postgres that has the
// migrations applied (see tests/contract/README in the file headers).
// Configure the connection with DATABASE_URL or the standard PG* env vars.
export default defineConfig({
  test: {
    include: ["tests/contract/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
