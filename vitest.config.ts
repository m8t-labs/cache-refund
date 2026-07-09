import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Oracle-parity + real-corpus tests can walk thousands of files.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
