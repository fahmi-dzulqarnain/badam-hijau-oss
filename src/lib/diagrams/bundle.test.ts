import { expect, test } from "vitest";
import {
  CODEMIRROR_FINGERPRINT,
  MERMAID_FINGERPRINTS,
  auditEagerChunks,
  chunksContaining,
  eagerChunksByRoute,
} from "./bundle";

/**
 * The shape `next build` actually writes, trimmed to two modules.
 *
 * Copied from `.next/server/app/(reader)/[space]/[...path]/page_client-reference-manifest.js` rather
 * than invented, including the `[project]/…` module keys and the `/_next/` chunk prefix, because the
 * parser's job is to read that file and a fixture in a format Next does not emit tests nothing.
 */
function manifest(route: string, chunksByModule: Record<string, string[]>): string {
  const clientModules = Object.fromEntries(
    Object.entries(chunksByModule).map(([id, chunks], index) => [
      id,
      { id: 1000 + index, name: "*", chunks, async: false },
    ]),
  );
  return (
    "globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n" +
    `globalThis.__RSC_MANIFEST[${JSON.stringify(route)}] = ` +
    JSON.stringify({ moduleLoading: { prefix: "", crossOrigin: "none" }, clientModules }) +
    ";"
  );
}

test("reads a route's eager chunks out of its client-reference manifest", () => {
  const source = manifest("/(reader)/[space]/[...path]/page", {
    "[project]/src/components/DocBody.tsx": ["/_next/static/chunks/aaa.js"],
    "[project]/src/components/Toc.tsx": ["/_next/static/chunks/aaa.js", "/_next/static/chunks/bbb.js"],
  });

  expect(eagerChunksByRoute(source)).toEqual({
    route: "/(reader)/[space]/[...path]/page",
    // De-duplicated, and rewritten from the URL the browser asks for to the path on disk.
    chunks: ["static/chunks/aaa.js", "static/chunks/bbb.js"],
  });
});

test("a route with no client components has no eager chunks", () => {
  expect(eagerChunksByRoute(manifest("/api/bugs/route", {})).chunks).toEqual([]);
});

/**
 * The three ways this parser could quietly examine nothing, each of which must be loud instead.
 *
 * This is the failure mode the module exists to prevent — a check that finds no Mermaid because it
 * found no *manifest* reads identically to a clean build. Next has already changed this artifact
 * once within this project's lifetime: the Webpack build writes `app-build-manifest.json`, which
 * the Turbopack build here does not produce at all.
 */
test("an unreadable manifest throws rather than reporting nothing", () => {
  expect(() => eagerChunksByRoute("")).toThrow(/no __RSC_MANIFEST assignment/);
  expect(() => eagerChunksByRoute("globalThis.__RSC_MANIFEST = {};")).toThrow(
    /no __RSC_MANIFEST assignment/,
  );
  expect(() =>
    eagerChunksByRoute('globalThis.__RSC_MANIFEST["/page"] = {"moduleLoading":{}};'),
  ).toThrow(/no clientModules/);
});

test("finds the fingerprint in a chunk and does not find it in the others", () => {
  const files = {
    "static/chunks/core.js": `var e=class extends Error{constructor(t){super(t),this.name="UnknownDiagramError"}}`,
    "static/chunks/reader.js": "export function DocBody(){}",
  };
  const read = (file: string) => files[file as keyof typeof files];

  expect(chunksContaining(Object.keys(files), read, MERMAID_FINGERPRINTS)).toEqual([
    "static/chunks/core.js",
  ]);
});

test("either fingerprint is enough on its own", () => {
  // Requiring both would fail open the day Mermaid rewords one of them, which is the direction a
  // security-shaped check must never fail in.
  for (const fingerprint of MERMAID_FINGERPRINTS) {
    expect(chunksContaining(["c"], () => `noise ${fingerprint} noise`, MERMAID_FINGERPRINTS)).toEqual(
      ["c"],
    );
  }
});

test("a route eagerly loading the library is named, with its chunk", () => {
  const routes = [
    { route: "/(reader)/[space]/[...path]/page", chunks: ["static/chunks/a.js", "static/chunks/m.js"] },
    { route: "/(reader)/search/page", chunks: ["static/chunks/a.js"] },
  ];

  const audit = auditEagerChunks(routes, ["static/chunks/m.js"]);

  expect(audit.offenders).toEqual([
    { route: "/(reader)/[space]/[...path]/page", chunk: "static/chunks/m.js" },
  ]);
  expect(audit.eagerChunks).toEqual(["static/chunks/a.js", "static/chunks/m.js"]);
});

/**
 * The non-vacuity companion, in the direction that matters: a **lazily**-loaded library is in some
 * chunk on disk and in no route's eager set, and the audit has to call that clean rather than
 * simply failing to look.
 */
test("a chunk the library lives in but no route eagerly loads is clean", () => {
  const routes = [{ route: "/(reader)/[space]/[...path]/page", chunks: ["static/chunks/a.js"] }];
  const audit = auditEagerChunks(routes, ["static/chunks/lazy-mermaid.js"]);

  expect(audit.offenders).toEqual([]);
  expect(audit.eagerChunks).toEqual(["static/chunks/a.js"]);
});

test("the control fingerprint is a string a bundler keeps", () => {
  // It is deliberately not a package name being imported — a bundler keeps none of those. It is the
  // text of a runtime error CodeMirror throws, which is why it survives minification, and the whole
  // reason the mermaid fingerprints are error strings too.
  expect(CODEMIRROR_FINGERPRINT).toBe("@codemirror/state");
});
