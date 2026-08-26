#!/usr/bin/env tsx
/**
 * Asserts, against `next build`'s own output, that Mermaid is in **no route's eager client
 * bundle**.
 *
 *   npm run build          (this runs as its second half)
 *   npx tsx scripts/check-diagram-bundle.ts    (on an existing .next)
 *
 * **Why a build step and not a vitest test.** The answer only exists after a build, and the
 * documented order in `PROGRESS.md` is `npm test` *then* `npm run build` — so a vitest test would
 * have to skip when `.next` is absent, which is the one thing this project has decided a guard may
 * never do: a check that finds nothing because it looked at nothing reads exactly like a pass. Bolted
 * to `build` instead, it cannot be skipped, and it runs inside `npm run test:e2e` and
 * `npm run smoke` for free because both of those build first.
 *
 * **Why the output and not the import statement.** Mermaid is 83 MB unpacked and `DocBody.tsx`
 * reaches it with `await import("mermaid")` under a branch. That *looks* dynamic; this project has
 * already measured a bundler treating an identical expression differently in two layers — the same
 * `readFileSync(new URL(...))` reads a real file from a route handler and gets a browser URL in a
 * Server Component — so "it is written as a dynamic import" is a claim about the source, not a
 * measurement of the bundle.
 *
 * The classification is in `src/lib/diagrams/bundle.ts`, which has its own tests including the cases
 * where it must fail. This file is the plumbing: find the manifests, read the chunks, print.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CODEMIRROR_FINGERPRINT,
  MERMAID_FINGERPRINTS,
  auditEagerChunks,
  chunksContaining,
  eagerChunksByRoute,
  type RouteChunks,
} from "../src/lib/diagrams/bundle";

const ROOT = join(import.meta.dirname, "..");
const BUILD = join(ROOT, ".next");
/** The route whose eager chunks must contain CodeMirror, or the scan itself is broken. */
const CONTROL_ROUTE = "/(editor)/edit/[pageId]/page";

function fail(message: string): never {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

function findManifests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, found);
    else if (entry.name.endsWith("_client-reference-manifest.js")) found.push(full);
  }
  return found;
}

const appDir = join(BUILD, "server/app");
if (!existsSync(appDir)) {
  fail(`No build to check: ${relative(ROOT, appDir)} does not exist. Run \`next build\` first.`);
}

const manifests = findManifests(appDir);
if (manifests.length === 0) {
  // Loud, because a renamed artifact is precisely how this check would start passing for free.
  fail(
    `No *_client-reference-manifest.js under ${relative(ROOT, appDir)}. Next has changed its ` +
      "build output; this check is not looking at anything.",
  );
}

const routes: RouteChunks[] = manifests.map((path) =>
  eagerChunksByRoute(readFileSync(path, "utf8")),
);

/** Every chunk the build emitted, not only the ones some route loads eagerly. */
const chunkDir = join(BUILD, "static/chunks");
const allChunks = readdirSync(chunkDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => join("static/chunks", name));

const readChunk = (file: string): string => {
  const full = join(BUILD, file);
  if (!existsSync(full)) fail(`A manifest names ${file}, which the build did not emit.`);
  return readFileSync(full, "utf8");
};

const mermaidChunks = chunksContaining(allChunks, readChunk, MERMAID_FINGERPRINTS);
const audit = auditEagerChunks(routes, mermaidChunks);

console.log(`\nDiagram bundle check — ${routes.length} routes, ${allChunks.length} client chunks`);
console.log(`  eager chunks across all routes: ${audit.eagerChunks.length}`);
console.log(
  `  chunks containing mermaid: ${mermaidChunks.length}` +
    (mermaidChunks.length > 0 ? ` (${mermaidChunks.join(", ")})` : ""),
);

/**
 * **The control, asserted before the result it makes meaningful.**
 *
 * Every sweep in this project is required to prove it can still see something real, because a
 * pattern that matches nothing looks exactly like a clean codebase — and here there are four ways
 * to look at nothing: no manifests, unresolvable chunk paths, a minifier that ate the fingerprint,
 * or `read` returning "". CodeMirror is statically imported by `Editor.tsx`, so the editor route
 * must be caught eagerly loading it. If that fails, nothing below is evidence.
 */
const control = routes.find((route) => route.route === CONTROL_ROUTE);
if (!control) {
  fail(`No manifest for the control route ${CONTROL_ROUTE}. Has it been renamed or removed?`);
}
const controlHits = chunksContaining(control.chunks, readChunk, [CODEMIRROR_FINGERPRINT]);
if (controlHits.length === 0) {
  fail(
    `The control failed: ${CONTROL_ROUTE} does not eagerly load any chunk containing ` +
      `"${CODEMIRROR_FINGERPRINT}", but Editor.tsx imports CodeMirror statically. This scan ` +
      "cannot see a heavy eager dependency, so its mermaid result proves nothing.",
  );
}
console.log(`  control: CodeMirror found eagerly on ${CONTROL_ROUTE} (${controlHits.join(", ")})`);

/**
 * **The second non-vacuity check.** Zero mermaid chunks would satisfy the assertion below
 * trivially — and would also be the reading if the dependency were uninstalled, if the dynamic
 * import were deleted, or if tree-shaking dropped it entirely. The library has to be *present and
 * lazy*, not absent.
 */
if (mermaidChunks.length === 0) {
  fail(
    "No chunk in the build contains mermaid at all. Either the dynamic import in " +
      "src/components/DocBody.tsx is gone, or the fingerprints in src/lib/diagrams/bundle.ts no " +
      "longer match what mermaid ships. Absent is not the same as lazy.",
  );
}

if (audit.offenders.length > 0) {
  for (const { route, chunk } of audit.offenders) {
    console.error(`  ${route} eagerly loads ${chunk}, which contains mermaid`);
  }
  fail(
    `Mermaid (83 MB unpacked) is in the eager client bundle of ${audit.offenders.length} route(s). ` +
      "It must be reached only through the `await import(\"mermaid\")` in " +
      "src/components/DocBody.tsx, under the branch that finds a diagram.",
  );
}

console.log("  OK — mermaid is in the build and eager on no route.\n");
