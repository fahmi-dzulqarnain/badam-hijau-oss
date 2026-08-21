import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
