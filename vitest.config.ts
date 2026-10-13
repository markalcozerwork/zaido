import { defineConfig } from "vitest/config";

// Unit tests: pure, no database. Colocated next to the code as *.test.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
