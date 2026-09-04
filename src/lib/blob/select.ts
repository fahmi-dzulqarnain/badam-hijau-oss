import { MemoryBlobStore } from "./memory";
import { GraphBlobStore } from "./graph";
import type { BlobStore } from "./store";

export type StoreKind = "graph" | "memory";

/**
 * Which store to use, or an error.
 *
 * There is deliberately NO DEFAULT. Both candidates are unsafe as a default in opposite
 * directions: `memory` would let a deployment accept uploads and silently lose them on the
 * next restart, and `graph` would break every laptop and `npm run smoke`, neither of which
 * has tenant credentials. Refusing to boot is the loud failure — the direction
 * `ALLOWED_EMAIL_DOMAINS` already chose when it denies everyone on empty.
 */
export function resolveStoreKind(env: Partial<NodeJS.ProcessEnv> = process.env): StoreKind {
  const raw = env.BLOB_STORE;
  if (raw !== "graph" && raw !== "memory") {
    throw new Error(
      `BLOB_STORE must be "graph" or "memory", got ${JSON.stringify(raw ?? null)}. ` +
        "There is no default: see src/lib/blob/select.ts.",
    );
  }
  // An ALLOWLIST of known development environments, NOT `!== "production"`.
  //
  // The inverted form was wrong and was caught by review. Next only DEFAULTS `NODE_ENV`
  // (`process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv` in its bin), so an explicitly
  // set value survives — `NODE_ENV=staging npx next start` warns and proceeds. Under the old
  // guard that combination accepted `memory` silently, in a genuinely deployed process, while
  // `.env.example` ships `BLOB_STORE="memory"` for the setup-db.sh reason. Anything that is
  // not recognisably a development environment must ask explicitly.
  if (
    raw === "memory" &&
    !DEV_ENVS.has(env.NODE_ENV ?? "") &&
    env.BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION !== "1"
  ) {
    throw new Error(
      `BLOB_STORE="memory" under NODE_ENV=${JSON.stringify(env.NODE_ENV ?? null)} loses every ` +
        "upload on restart and cannot be shared between replicas. Set " +
        "BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 only if you mean it.",
    );
  }
  return raw;
}

/** Where an in-memory store needs no explanation. Everything else must opt in. */
const DEV_ENVS = new Set(["development", "test"]);

/**
 * Whether the unauthenticated dev upload route may exist.
 *
 * **This is a SECOND, positive flag, and it is deliberately not `memoryStoreEnabled()`.**
 * Selecting the memory store answers "where do bytes go"; this answers "does an
 * unauthenticated write endpoint exist", and those are different questions that were
 * originally conflated.
 *
 * The polarity is what matters, and getting it backwards is what review caught. Gating the
 * route on the memory store alone made it **on by default** in every process where `NODE_ENV`
 * was not the literal string `production` — the exact inverse of `testLoginEnabled`, which is
 * off everywhere until someone writes an exact `"1"`. This now matches that discipline: off
 * unless asked for, an exact `"1"`, and additionally requiring the memory store, so the flag
 * alone cannot open a route in a process whose bytes go to SharePoint.
 */
export function devUploadEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.ALLOW_DEV_UPLOAD === "1" && memoryStoreEnabled(env);
}

/**
 * Whether the memory store — and therefore the dev upload route — is live.
 *
 * Gated on an exact `"1"`-style match through `resolveStoreKind`, but unlike it this NEVER
 * throws: the dev upload route calls it on every request, including in a deployment where
 * `BLOB_STORE` is missing, and there the answer must be "no" rather than a 500 that reads
 * like the route exists.
 */
export function memoryStoreEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  try {
    return resolveStoreKind(env) === "memory";
  } catch {
    return false;
  }
}

let cached: BlobStore | undefined;

export function blobStore(): BlobStore {
  if (cached) return cached;
  cached =
    resolveStoreKind() === "memory"
      ? new MemoryBlobStore(process.env.AUTH_URL ?? "http://localhost:3000")
      : new GraphBlobStore();
  return cached;
}

/** The memory instance, for the dev upload route. Throws if the memory store is not selected. */
export function memoryStore(): MemoryBlobStore {
  const store = blobStore();
  if (!(store instanceof MemoryBlobStore)) throw new Error("memory store is not selected");
  return store;
}
