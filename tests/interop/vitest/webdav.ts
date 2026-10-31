import { defineConfig } from "vitest/config";
import { interopWorkers } from "./shared";

export default defineConfig({
  test: {
    include: [
      "tests/interop/webdav-note-ui.interop.ts",
      "tests/interop/passkey-webdav-counters.interop.ts",
      "tests/interop/passkey-zip-webdav-counters.interop.ts",
      "tests/interop/passkey-file-counters.interop.ts"
    ],
    ...interopWorkers
  }
});
