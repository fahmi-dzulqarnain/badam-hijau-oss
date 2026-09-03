import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  /**
   * **One worker, because the fixtures are shared state.**
   *
   * Playwright's default is one worker per two cores and it parallelises across *files*, which
   * was harmless while `authoring.spec.ts` was the only file writing fixtures. It is not
   * harmless now: `sweep()` deletes every page whose slug starts with `e2e-` and every audit and
   * redirect row written since the worker started, so two spec files sweeping in parallel delete
   * each other's fixtures mid-test — and the failure would land on whichever test happened to
   * read a row after the other worker's `beforeEach`, which is the least debuggable shape there
   * is. The sweep cannot be narrowed per file either: the marker is a slug prefix, and Phase 3's
   * fixtures carry the same one on purpose so a crashed run cleans up after itself.
   *
   * It also makes the count assertion mean something. `snapshotCounts()` is a count of the whole
   * database, so a second worker creating a page between `beforeAll` and `afterAll` fails the
   * idempotence check of a suite that leaked nothing.
   */
  workers: 1,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run build && npx next start --port 3100",
    port: 3100,
    reuseExistingServer: false,
    // The command builds before it serves, and a cold Next build here takes longer than
    // the 60s default — which fails the whole run before a single test starts.
    timeout: 300_000,
    // `next start` sets NODE_ENV=production, so the memory store needs its override here —
    // that flag only accepts "uploads are lost on restart", which is correct for a test
    // harness. ALLOW_DEV_UPLOAD is the separate flag that opens the unauthenticated upload
    // endpoint; both are deliberately explicit, and neither alone is sufficient.
    //
    // AUTH_URL is set here for a reason unrelated to auth: `MemoryBlobStore` mints its upload
    // session URLs against `process.env.AUTH_URL`, defaulting to `.env`'s own
    // `http://localhost:3000` when unset — not this port. Left out, every upload session this
    // suite mints points at a server nothing is listening on, and the spec's direct `PUT` to it
    // fails to connect rather than exercising anything.
    env: {
      ALLOW_TEST_LOGIN: "1",
      GIT_SHA: "df0ef11abc",
      BLOB_STORE: "memory",
      BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      ALLOW_DEV_UPLOAD: "1",
      AUTH_URL: "http://localhost:3100",
    },
  },
});
