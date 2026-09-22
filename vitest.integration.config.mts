import { defineConfig } from "vitest/config";
import { DB_INTEGRATION_TESTS } from "./vitest.config.mts";

export default defineConfig({
  test: {
    environment: "node",
    include: DB_INTEGRATION_TESTS,
    hookTimeout: 20000,
    testTimeout: 20000,
    globalSetup: ["./test/global-setup.ts"],
  },
});
