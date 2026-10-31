import { defineConfig } from "vitest/config";
import { interopWorkers } from "./shared";

export default defineConfig({
  test: {
    include: [
      "tests/interop/keepass-android.interop.ts",
      "tests/interop/keepass-icon-ui.interop.ts"
    ],
    ...interopWorkers
  }
});
