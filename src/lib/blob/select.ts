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
  if (
    raw === "memory" &&
    env.NODE_ENV === "production" &&
    env.BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION !== "1"
  ) {
    throw new Error(
      'BLOB_STORE="memory" in production loses every upload on restart and cannot be shared ' +
        "between replicas. Set BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 only if you mean it.",
    );
  }
  return raw;
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
