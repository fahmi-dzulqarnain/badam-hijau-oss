/**
 * The editor's publish surface, as pure functions: where a refusal belongs, what the status
 * picker writes, and what a dormant cascade reads like.
 *
 * Pure — strings and plain objects in, strings and plain objects out. No React, no `fetch`, no
 * Prisma, no Markdown parser. Same reason `state.ts`, `save.ts` and `scheduler.ts` are separate
 * from the component: this is where a publish reply meets a document, and every branch of it
 * needs a test rather than the coverage of whatever someone can reproduce by hand in a browser.
 *
 * Statuses cross this boundary as plain strings, deliberately. They arrive as JSON from the
 * publish endpoint and as props from a server component that already narrowed them; re-narrowing
 * to `DocStatus` here would put a Prisma import in a client bundle to restate a guarantee the
 * server made.
 *
 * ## The one rule this module must not break
 *
 * **Nothing here may be reached from the save path.** Phase 2 settled the shape — a draft accepts
 * what publish refuses — and Task 2 made the frontmatter parser return a typed failure rather
 * than throw precisely so that autosave never fails because the YAML is mid-keystroke. The
 * functions below never validate: `readFrontmatterStatus` returns whatever text it finds,
 * `frontmatterKeyLine` returns a line or null, and neither can produce an error for anything to
 * act on. The component calls them for *display*, and the only thing that judges frontmatter is
 * still `publishPage`, on the server, when the author asks for a publish.
 */

/**
 * The reply the publish endpoint sends for one refused key, as this module reads it off the
 * wire. Structurally `PublishFieldError` from `src/lib/pages/publish.ts`, read defensively
 * rather than imported: it arrives as JSON from a server that may be a deploy ahead.
 */
export type PublishError = {
  field: string;
  key: string | null;
  code: string;
  message: string;
};

/** One relation a publish recorded and did not act on — the server's `dormant` entries. */
export type DormantCascade = {
  /** The frontmatter key that declared it, so the notice can quote the author's own line. */
  key: string;
  /** The reference exactly as the author wrote it. */
  ref: string;
  /** Where the target goes once this page reaches the status the cascade is gated on. */
  wouldRetireInto: string;
};

/**
 * Where a refusal belongs on screen.
 *
 * The plan gave this task the question the error shape could not answer on its own: frontmatter
 * has **no per-key input** — it is prose in one textarea — so `field: "markdown"` can only
 * underline the whole pane, and "your frontmatter is wrong, somewhere in these six lines" is not
 * a message anyone can act on.
 *
 * The answer is a **line number**, computed from the document the author is looking at, with the
 * key as the fallback when the line cannot be found. A line is something the editor can scroll
 * to, select and put a cursor in — which is as close to "against the offending key" as a single
 * textarea can get — and it survives the author reordering their keys, which a line number
 * threaded out of the YAML parser at publish time would not.
 */
export type ErrorPlacement =
  /** The title input has one of its own. */
  | { kind: "title" }
  /** A line in the document, 1-based, with the key that produced it. */
  | { kind: "line"; line: number; key: string }
  /** A key that is named and is not in the document — a `status:` the author never wrote. */
  | { kind: "key"; key: string }
  /** Nothing narrower than the document: a malformed block, an empty draft. */
  | { kind: "document" };

export type PlacedError = PublishError & { placement: ErrorPlacement };

/**
 * **All** of them, not the first — the plan's other half of the same question.
 *
 * `publishPage` returns `errors` as well as `error` because frontmatter is several keys written
 * in one pass, and Task 7 left *which* the editor renders open. It renders all of them, and the
 * reason is the loop: two mistyped keys fixed one publish attempt at a time is two round trips
 * to learn two things the server already knew on the first. `errors[0] === error` is an
 * invariant the server pins, so rendering the list is a superset of rendering the one.
 *
 * Order is the server's and is not sorted here. It is the order the keys were validated in,
 * which is close enough to document order to read naturally, and re-sorting by line number
 * would put the errors that *have* no line last — which is exactly backwards, since a
 * whole-document failure is the one to read first.
 */
export function placeErrors(
  markdown: string,
  errors: readonly PublishError[],
): PlacedError[] {
  return errors.map((error) => ({ ...error, placement: placeError(markdown, error) }));
}

function placeError(markdown: string, error: PublishError): ErrorPlacement {
  if (error.field === "title") return { kind: "title" };

  // A transition refusal carries `field: "status"` and no key, because `validateTransition` is
  // about a page and not about a document. In this editor the status IS a document line — the
  // picker writes `status:` into the frontmatter rather than sending a status of its own — so
  // that refusal belongs against the same line every other frontmatter refusal does.
  const key = error.key ?? (error.field === "status" ? STATUS_KEY : null);
  if (key === null) return { kind: "document" };

  const line = frontmatterKeyLine(markdown, key);
  return line === null ? { kind: "key", key } : { kind: "line", line, key };
}

/** The frontmatter key that carries a page's requested status. */
export const STATUS_KEY = "status";

/**
 * The frontmatter block's fence, as micromark actually recognises it — **measured, not guessed**.
 *
 * Exactly three dashes at column zero, trailing spaces and tabs allowed, a carriage return
 * allowed after them. Probed against `splitFrontmatter` itself: `----` is not a fence, ` ---` is
 * not a fence, `...` does not close a block, and a block that is never closed is not frontmatter
 * at all. Those are the four shapes a hand-written scanner gets wrong, and this file's tests
 * carry each of them.
 */
const FENCE = /^---[ \t]*\r?$/;

/** A top-level key line: the key at column zero, then a colon. */
const keyLine = (key: string): RegExp =>
  new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:`);

/**
 * The lines of the frontmatter block, or `null` when the document has none.
 *
 * A line scanner rather than the real parser, and the trade is deliberate. `splitFrontmatter`
 * pulls in `unified`, `remark-parse`, `remark-frontmatter` and `yaml` — a Markdown toolchain in
 * the editor bundle, run on every keystroke — to answer a question about the first few lines of
 * a document. What it buys is exactness, and this scanner buys the same exactness for the only
 * shape that matters by borrowing the parser's own rule: **frontmatter is the first node or it
 * is not frontmatter.** Line 1 is a fence, or the answer is `null`.
 *
 * That is what makes the three shapes PROGRESS records go the right way rather than the wrong
 * way: a leading blank line, a code fence opening the document, and `Title\n---` (a setext
 * heading) all have something other than `---` on line 1, so all three answer `null`. An
 * implementation that `trimStart()`s or scans for the first `---` gets all three wrong.
 *
 * And where the two could still disagree, they disagree **safely**: this is used to point at a
 * line and to write one. Answering `null` too often costs a message its line number; answering
 * it too rarely would point at the wrong line, so every uncertain case answers `null`.
 */
function frontmatterLines(markdown: string): { lines: string[]; close: number } | null {
  const lines = markdown.split("\n");
  const first = lines[0];
  if (first === undefined || !FENCE.test(first)) return null;

  for (let i = 1; i < lines.length; i += 1) {
    // The closing fence. Everything between it and line 0 is the block.
    if (FENCE.test(lines[i] ?? "")) return { lines, close: i };
  }
  // Never closed, so micromark sees a thematic break and a document, not frontmatter. Measured.
  return null;
}

/**
 * The 1-based line number of `key:` in the frontmatter block, or `null`.
 *
 * 1-based because that is what an editor counts in and what CodeMirror's `doc.line(n)` takes.
 * The **first** occurrence: a repeated key is refused upstream as `frontmatter-unparseable`
 * (`yaml` reports "Map keys must be unique"), so a document that reaches a key error has one.
 */
export function frontmatterKeyLine(markdown: string, key: string): number | null {
  const block = frontmatterLines(markdown);
  if (block === null) return null;

  const pattern = keyLine(key);
  for (let i = 1; i < block.close; i += 1) {
    if (pattern.test(block.lines[i] ?? "")) return i + 1;
  }
  return null;
}

/**
 * The `status:` the document declares, verbatim and unvalidated, or `null`.
 *
 * Unvalidated is the point — see this module's header. The picker shows what the document says,
 * including when what it says is not a status at all, because the alternative is a control that
 * silently displays something other than the text under it. `publishPage` is what judges the
 * value, and it does so with a sentence that names the key.
 *
 * Surrounding quotes are stripped so `status: "ACCEPTED"` selects the same option a bare
 * `ACCEPTED` does; nothing else is interpreted. A key with nothing after it — every template
 * ships that way — is `null` rather than the empty string, because "not declared" is what it
 * means and it is what `validateFrontmatter` makes of it.
 */
export function readFrontmatterStatus(markdown: string): string | null {
  const block = frontmatterLines(markdown);
  if (block === null) return null;

  const pattern = keyLine(STATUS_KEY);
  for (let i = 1; i < block.close; i += 1) {
    const line = block.lines[i] ?? "";
    if (!pattern.test(line)) continue;
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/\r$/, "");
    const unquoted = /^(["'])(.*)\1$/.exec(value);
    const text = (unquoted?.[2] ?? value).trim();
    return text.length === 0 ? null : text;
  }
  return null;
}

/**
 * The document with its `status:` set — the status picker's whole mechanism.
 *
 * ## The picker edits the document rather than sending a status of its own
 *
 * `publishPage` takes an optional `status`, no product caller passes one, and the publish route
 * reads no body. Wiring the picker through that option was the other design and it was rejected,
 * for the reason Task 7 recorded when it wired the frontmatter into the transition and left this
 * decision here: precedence is `options.status ?? frontmatter.status ?? default`, so a picker
 * that sent its own value would **outrank** the author's `status:` line. The version row stores
 * the frontmatter that was validated, so an ADR whose document says `ACCEPTED` published through
 * a picker set to `PROPOSED` would commit a version whose stored frontmatter and whose page
 * status disagree — §6.3's *"status is never maintained by hand in two places"*, broken by the
 * one write that exists to enforce it. Repairing that would mean a new refusal for a
 * contradiction the surface itself created.
 *
 * Writing the line has no such problem: there is one status, in the document, where the author
 * can see it, where the preview and the git mirror will find it, and where the same validation
 * every other key gets applies to it. The edit lands in CodeMirror's undo history like any other,
 * and autosave carries it exactly as it carries a keystroke.
 *
 * ## Three cases, and none of them deletes anything
 *
 * - The block declares `status:` — the value is replaced, indentation and key spelling left as
 *   the author wrote them.
 * - The block exists without it — the line is inserted **first**, which is where
 *   `frontmatterKeys` puts it and therefore where every template already prints it.
 * - There is no block — one is created above the document. A `status:` is a legal key for every
 *   doc type, so this is never an illegal document, and the existing text is untouched.
 *
 * `status` is one of the values `publishDestinations` produced — a `DocStatus` member, letters
 * and underscores — so there is nothing to quote or escape. That is a precondition of the caller
 * and not a claim about arbitrary input.
 */
export function setFrontmatterStatus(markdown: string, status: string): string {
  const block = frontmatterLines(markdown);
  if (block === null) return `---\n${STATUS_KEY}: ${status}\n---\n\n${markdown}`;

  const { lines, close } = block;
  const pattern = keyLine(STATUS_KEY);
  for (let i = 1; i < close; i += 1) {
    const line = lines[i] ?? "";
    if (!pattern.test(line)) continue;
    // The key exactly as written, the value replaced. A trailing `\r` is preserved so a CRLF
    // document does not acquire one lone LF line.
    const key = line.slice(0, line.indexOf(":"));
    const next = [...lines];
    next[i] = `${key}: ${status}${line.endsWith("\r") ? "\r" : ""}`;
    return next.join("\n");
  }

  const next = [...lines];
  next.splice(1, 0, `${STATUS_KEY}: ${status}`);
  return next.join("\n");
}

/**
 * The smallest single-range edit that turns `before` into `after`, or `null` if they are equal.
 *
 * The status picker produces a whole new document, and dispatching that as
 * `{ from: 0, to: doc.length }` would work and would be wrong: CodeMirror maps the cursor, the
 * selection and the scroll position **through** a change, so replacing everything moves the
 * caret to the end of a document somebody is in the middle of typing, and puts the entire file
 * into the undo history as one entry. Replacing only the run that actually differs leaves a
 * cursor further down the document exactly where it was, and undoes as one small edit.
 *
 * Common prefix and common suffix, which is enough because every write this module makes is one
 * contiguous run — a value replaced, or a line inserted. It is also correct, if not minimal, for
 * anything else: the range it names always contains every difference.
 *
 * The two runs are clamped so they cannot overlap on repetitive text (`aaa` → `aaaa`, where the
 * prefix and suffix would otherwise each claim the same characters and produce a negative range).
 */
export function minimalReplacement(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;

  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/**
 * What the editor does with one publish reply.
 *
 * The same shape as `saveOutcome`: one response in, one thing to render out, so the component
 * holds no branching of its own. Every failure branch returns a SENTENCE, for the reason that
 * function gives — the editor renders it verbatim, and an empty banner after a refused publish
 * is indistinguishable from one that went out.
 */
export type PublishOutcome =
  | {
      type: "published";
      /** The reader URL to navigate to. */
      href: string;
      /** The status it actually landed on, which the notice below quotes. */
      status: string;
      dormant: DormantCascade[];
    }
  /** The document was refused. Every error, each placed against something visible. */
  | { type: "refused"; errors: PlacedError[] }
  /** Everything else: a 401, a 500, a body that could not be read. */
  | { type: "failed"; message: string };

export function publishOutcome(args: {
  status: number;
  /** The parsed JSON body, or `null` if it was absent or unparseable. */
  body: unknown;
  /** The document as it stands, for placing the refusals against their lines. */
  markdown: string;
}): PublishOutcome {
  const { status, body, markdown } = args;

  if (status === 200) {
    const href = readString(body, "href");
    // A 200 with no usable href is not a publish this surface can act on: navigating nowhere
    // and reporting success would leave the author believing a page exists that they cannot
    // reach. Reported as a failure, which is the safe reading and is loud.
    if (href === null) {
      return { type: "failed", message: "Published, but the server sent no page address." };
    }
    return {
      type: "published",
      href,
      status: readString(body, "status") ?? "",
      dormant: readDormant(body),
    };
  }

  const errors = readErrors(body);
  if (status === 422 && errors.length > 0) {
    return { type: "refused", errors: placeErrors(markdown, errors) };
  }

  // The endpoint's own sentence, verbatim, exactly as this surface has rendered refusals since
  // Phase 2: every refusal `publishPage` produces is already written for the person who has to
  // act on it, and a second copy here would be a worse one.
  const message = readString(body, "message");
  return {
    type: "failed",
    message:
      message ?? `Not published — the server refused it (${status}).`,
  };
}

/**
 * The dormant-cascade sentence, or `null` when there is nothing to say.
 *
 * A lead and one line per declaration, rather than one paragraph, because the count is not
 * bounded: an ADR may retire several predecessors at once, and a sentence that lists them inline
 * stops being readable at three.
 *
 * It quotes the **key and the reference the author wrote**, and names the status the page landed
 * on and the status the target would reach. Those four are what turn "ADR-31 is still current"
 * from a bug report into an explanation, and every one of them comes from the server: this
 * function decides no dormancy of its own, because the `ACCEPTED` gate is stated once, in
 * `src/lib/lifecycle/relations.ts`.
 */
export function dormantNotice(
  dormant: readonly DormantCascade[],
  publishedAs: string,
): { lead: string; items: string[] } | null {
  if (dormant.length === 0) return null;
  return {
    lead:
      `Published as ${publishedAs}. ` +
      (dormant.length === 1
        ? "One declaration was recorded and has not taken effect yet:"
        : `${dormant.length} declarations were recorded and have not taken effect yet:`),
    items: dormant.map(
      (cascade) =>
        `\`${cascade.key}: ${cascade.ref}\` — that page is unchanged. It moves to ` +
        `${cascade.wouldRetireInto} on the publish that accepts this one, not on this one.`,
    ),
  };
}

/** The `errors` array, read defensively: anything that is not a usable error is dropped. */
function readErrors(body: unknown): PublishError[] {
  const raw = readRecord(body)?.["errors"];
  if (!Array.isArray(raw)) {
    // A server that sends only the singular `error` fields still gets its one message placed.
    const message = readString(body, "message");
    const code = readString(body, "code");
    const field = readString(body, "field");
    if (message === null || code === null || field === null) return [];
    return [{ field, key: readString(body, "key"), code, message }];
  }

  const errors: PublishError[] = [];
  for (const entry of raw) {
    const message = readString(entry, "message");
    const code = readString(entry, "code");
    const field = readString(entry, "field");
    if (message === null || code === null || field === null) continue;
    errors.push({ field, key: readString(entry, "key"), code, message });
  }
  return errors;
}

function readDormant(body: unknown): DormantCascade[] {
  const raw = readRecord(body)?.["dormant"];
  if (!Array.isArray(raw)) return [];

  const dormant: DormantCascade[] = [];
  for (const entry of raw) {
    const key = readString(entry, "key");
    const ref = readString(entry, "ref");
    const wouldRetireInto = readString(entry, "wouldRetireInto");
    // A partial entry is dropped rather than rendered with an `undefined` in the sentence. The
    // notice exists to stop an author reading a correct outcome as a bug; a garbled one would
    // do the opposite.
    if (key === null || ref === null || wouldRetireInto === null) continue;
    dormant.push({ key, ref, wouldRetireInto });
  }
  return dormant;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string | null {
  const found = readRecord(value)?.[key];
  return typeof found === "string" ? found : null;
}
