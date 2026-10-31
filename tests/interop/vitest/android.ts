import { defineConfig } from "vitest/config";
import { interopWorkers } from "./shared";

/** Android / MDBX2 / real-services interop. Pass a file path to run one suite. */
export default defineConfig({
  test: {
    include: ["tests/interop/**/*.interop.ts"],
    ...interopWorkers
  }
});
