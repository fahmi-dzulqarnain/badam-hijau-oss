import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run build && npx next start --port 3100",
    port: 3100,
    reuseExistingServer: false,
    // The command builds before it serves, and a cold Next build here takes longer than
    // the 60s default — which fails the whole run before a single test starts.
    timeout: 300_000,
    env: { ALLOW_TEST_LOGIN: "1", GIT_SHA: "df0ef11abc" },
  },
});
