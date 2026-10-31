import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vault tests use the production Argon2 parameters and real encrypted writes.
    // Bound concurrent workers so CPU/memory contention does not exhaust their budget.
    maxWorkers: 2,
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "tests/interop/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"]
  }
});
