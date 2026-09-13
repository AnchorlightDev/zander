import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.mjs", "tests/**/*.test.js"],
    globals: false,
    // The suite pulls in heavy transitive imports (discord.js, @prisma/client,
    // fastify). On a cold module cache — a fresh CI runner, or the first run
    // after an install — that import phase can exceed the 5s default and fail
    // tests that would otherwise pass in milliseconds. These timeouts are for
    // import cost, not slow assertions.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
