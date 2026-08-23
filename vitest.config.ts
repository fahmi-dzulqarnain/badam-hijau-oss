import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    globalSetup: ["tests/setup/global-setup.ts"],
    fileParallelism: false,
    // next-auth reaches for `next/server`, which Vite's node resolution cannot satisfy from
    // an externalised dependency — the auth config is otherwise unimportable from a test.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
