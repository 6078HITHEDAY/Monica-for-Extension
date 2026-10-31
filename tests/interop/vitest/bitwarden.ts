import { defineConfig } from "vitest/config";
import { interopWorkers } from "./shared";

export default defineConfig({
  test: {
    include: ["tests/interop/bitwarden-contract.interop.ts"],
    ...interopWorkers
  }
});
