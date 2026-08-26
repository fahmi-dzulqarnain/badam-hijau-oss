/**
 * Reading `next build`'s own output to answer one question: **is Mermaid in the eager client
 * bundle of any route?**
 *
 * It is 83 MB unpacked (`du -sh node_modules/mermaid`, `mermaid@11.17.2`), and the plan is explicit
 * that the answer must come from the build's output rather than from an inspection of the import
 * statement — because this project has already measured a bundler behaving differently per layer:
 * the identical `readFileSync(new URL("./x.md", import.meta.url))` reads a real file from a route
 * handler and receives a *browser* URL in a Server Component. An `await import()` looking dynamic in
 * the source is exactly the shape that claim would take.
 *
 * The logic lives here rather than inside `scripts/check-diagram-bundle.ts` so it can be tested
 * against a manifest this repository writes by hand, including the cases where it must **fail**. A
 * checker whose only exercise is the build it is checking is a checker that has never been seen to
 * say no.
 */

/**
 * Literal strings Mermaid's core carries and nothing else in this application does.
 *
 * Both survive minification because both are string literals rather than identifiers:
 * `UnknownDiagramError` is assigned to `this.name` in Mermaid's own error class, and the sentence
 * is the message thrown when `detectType` runs out of detectors. Chosen over the package name
 * because a bundler keeps no package names — `@codemirror/state` appears exactly **once** in a
 * 625 KB CodeMirror chunk, and only because it happens to be inside a runtime error message.
 *
 * Either one is enough; requiring both would make the check fail open the day Mermaid rewords a
 * message.
 */
export const MERMAID_FINGERPRINTS = [
  "UnknownDiagramError",
  "No diagram type detected",
] as const;

/**
 * The **control**: a heavy dependency this application deliberately *does* load eagerly.
 *
 * Every sweep in this project is required to have a companion proving the pattern can still see
 * something real, because a guard that matches nothing looks exactly like a clean codebase — and
 * this one would report success if the manifest format changed, if the chunk paths stopped
 * resolving, or if `read` silently returned "". CodeMirror is statically imported by `Editor.tsx`,
 * so it must be found in the editor route's eager chunks. If it is not, the scan is broken and the
 * Mermaid result means nothing.
 *
 * The string is the one measured to survive Turbopack's minifier: it is inside the text of a
 * runtime error CodeMirror throws about duplicate instances.
 */
export const CODEMIRROR_FINGERPRINT = "@codemirror/state";

export type RouteChunks = {
  /** The route as Next names it, e.g. `/(reader)/[space]/[...path]/page`. */
  route: string;
  /** Build-root-relative chunk paths, e.g. `static/chunks/abc.js`. */
  chunks: string[];
};

/**
 * The eager client chunks of one route, from its `*_client-reference-manifest.js`.
 *
 * That file is the right artifact and the two obvious alternatives are not.
 * `.next/build-manifest.json` carries only the root shell under Turbopack (`pages: {}` for every
 * app route, measured), and `.next/app-build-manifest.json` — which the equivalent Webpack build
 * writes — **does not exist at all** here. This one is a `globalThis.__RSC_MANIFEST[...] = {…}`
 * assignment whose `clientModules` map lists, per client module the route needs, the chunks that
 * must be present before it can run.
 *
 * **Throws rather than returning null on anything it cannot read.** The failure mode this whole
 * module exists to prevent is a check that quietly examines nothing.
 */
export function eagerChunksByRoute(manifestSource: string): RouteChunks {
  const match = /globalThis\.__RSC_MANIFEST\[(?<quoted>"(?:[^"\\]|\\.)*")\]\s*=\s*/.exec(
    manifestSource,
  );
  if (!match?.groups?.quoted) {
    throw new Error("Not a client-reference manifest: no __RSC_MANIFEST assignment found.");
  }
  const route = JSON.parse(match.groups.quoted) as string;

  const body = manifestSource.slice(match.index + match[0].length).trim();
  const parsed = JSON.parse(body.endsWith(";") ? body.slice(0, -1) : body) as {
    clientModules?: Record<string, { chunks?: string[] }>;
  };
  if (!parsed.clientModules) {
    throw new Error(`Manifest for ${route} has no clientModules map.`);
  }

  const chunks = new Set<string>();
  for (const entry of Object.values(parsed.clientModules)) {
    for (const chunk of entry.chunks ?? []) chunks.add(buildRelative(chunk));
  }
  return { route, chunks: [...chunks].sort() };
}

/**
 * `/_next/static/chunks/x.js` in a manifest is `static/chunks/x.js` under `.next` on disk. The
 * prefix is how the browser asks for it, not where it lives.
 */
function buildRelative(chunk: string): string {
  return chunk.replace(/^\/?_next\//, "");
}

/**
 * Which of `files` contain any of `needles`.
 *
 * `read` is injected so the tests can drive this with strings, and so the script can decide what
 * happens to a chunk it cannot read — which it treats as a failure, not as a miss.
 */
export function chunksContaining(
  files: Iterable<string>,
  read: (file: string) => string,
  needles: readonly string[],
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = read(file);
    if (needles.some((needle) => text.includes(needle))) hits.push(file);
  }
  return hits.sort();
}

export type BundleAudit = {
  /** Every route that eagerly loads a chunk containing the library, with the chunk named. */
  offenders: { route: string; chunk: string }[];
  /** The union of every route's eager chunks — what a first paint can cost. */
  eagerChunks: string[];
};

/**
 * The verdict: no route may eagerly load a chunk the library is in.
 *
 * Stated over **every** route rather than over "a route with no diagram", and that is stronger than
 * the plan asks for on purpose. A reader page *may contain* a diagram, so there is no route this
 * library is allowed to be eager on — the whole point of the dynamic import is that the reader route
 * pays nothing until a document actually has a fence. Restricting the assertion to `/search` would
 * pass a build that shipped 83 MB to every page of the product.
 */
export function auditEagerChunks(
  routes: readonly RouteChunks[],
  libraryChunks: readonly string[],
): BundleAudit {
  const library = new Set(libraryChunks);
  const offenders: { route: string; chunk: string }[] = [];
  const eager = new Set<string>();

  for (const route of routes) {
    for (const chunk of route.chunks) {
      eager.add(chunk);
      if (library.has(chunk)) offenders.push({ route: route.route, chunk });
    }
  }

  return { offenders, eagerChunks: [...eager].sort() };
}
