import type { DocStatus, DocType } from "@prisma/client";
import {
  serializeFrontmatter,
  splitFrontmatter,
  type FrontmatterValue,
} from "@/lib/markdown/frontmatter";

/**
 * The bytes the git mirror writes for one published version.
 *
 * Pure: values in, a string out. No database, no git, no filesystem — nothing here spawns a
 * subprocess or knows where the file goes (`src/lib/git/paths.ts` owns that), so every judgement
 * below is unit-testable with a literal. The two Prisma imports are `import type` and erased at
 * compile time; they are here so that a new `DocStatus` or `DocType` is a compile error at the
 * call site rather than a string that silently means nothing.
 *
 * ## The file is composed from the row, not copied from it
 *
 * Phase 5's decision, taken because a verbatim copy cannot work: `publishPage` stores
 * `markdown: draft.markdown` — the author's whole document, their frontmatter text included —
 * while `title` is a **column** and appears nowhere in that text (the ADR template's frontmatter
 * has no `title:` key). A byte-for-byte mirror would therefore produce files that cannot say
 * what they are. And `PageVersion.frontmatter` is not the author's text either: it is what
 * validation *accepted*, deliberately a different value — `supersedes: decisions/adr-0031` is a
 * scalar in the draft and a one-element array in the column.
 *
 * So this writes a canonical block from the row, then the author's body with the author's own
 * frontmatter removed. What is given up, stated rather than discovered: the author's frontmatter
 * **comments** do not reach the mirror (the templates ship explanatory ones, and they are
 * scaffolding rather than content), and neither do keys the validator dropped.
 *
 * ## The key order, which is a design decision
 *
 * Insertion order is what `serializeFrontmatter` writes (`sortMapEntries: false`, stated there),
 * so this order is the order a human reads in a diff. It runs
 * **identity → address → classification → provenance → the author's own metadata**, and
 * everything the application owns comes before anything the author owns.
 *
 * | # | Key | Source | Why it is here, and here |
 * |---|---|---|---|
 * | 1 | `title` | `PageVersion.title` | What the document *is*. A reader scanning a diff identifies the page by name first, and this is the one field that exists nowhere else in the file or in its path. |
 * | 2 | `space` | `Space.key` | Where it lives. |
 * | 3 | `path` | `Page.path` | Its address inside the space. |
 * | 4 | `docType` | `Page.docType` | The type of document, which decides both the status vocabulary and which `declared` keys are legal — so it reads before either. |
 * | 5 | `status` | `PageVersion.status` | The lifecycle field, and the one that moves on its own: a Phase 3 cascade can retire a page without a word of its prose changing, and this line is the only place such a publish is visible. |
 * | 6 | `version` | `PageVersion.id` | Provenance starts here. It is the row that produced these exact bytes, and the one value that ties a file in the mirror back to the application. |
 * | 7 | `author` | `User.name`, `User.email` | Who published it. Nested, so a name and an address are two independently quoted scalars rather than one `Name <email>` string this module would have to compose — composing that format is a second parser to inject into. |
 * | 8 | `publishedAt` | `PageVersion.createdAt` | When. See below: this is the version's own timestamp, not `Page.publishedAt`. |
 * | 9 | `declared` | `PageVersion.frontmatter` | The author's own accepted metadata, verbatim. Last, and **nested**, for two reasons: it is the only author-influenced key space in the block, and nesting it means no key inside it can collide with or shadow a canonical one. That does not depend on `validateFrontmatter`'s key allowlist holding in a module three files away — the same argument Task 2 makes for verifying path containment rather than trusting `Page.path`. |
 *
 * `space` and `path` duplicate what Task 2 puts in the file's own location, and that is
 * deliberate: a file's location is not part of the file, so a blob read on its own — out of a
 * `git show`, an archive, a copy someone mailed — would otherwise not say where it came from.
 * The duplication also means a **move** produces a content diff and not only a rename, which is
 * what makes a rename reviewable rather than a silent tree edit.
 *
 * **`publishedAt` is `PageVersion.createdAt`, and the plan's word for it is the confusing half.**
 * `Page.publishedAt` moves to "now" on every publish, so reading it here would (a) put a
 * different timestamp in a file whose content had not changed and (b) give the *wrong* instant
 * whenever the mirror job runs late, which is the normal case after a failed push has backed
 * off. The version's own `createdAt` is immutable, is within milliseconds of the `publishedAt`
 * that publish wrote, and is the only one of the two that is a property of these bytes.
 *
 * ### What is deliberately absent
 *
 * - **`gitSha`** — the sha of the commit that contains this file cannot be inside it. (It is
 *   also the wrong `gitSha` to reach for by reflex: three unrelated things in this codebase
 *   carry that name, and `buildInfo().gitSha` is the application build, not the content
 *   repository. Nothing in `src/lib/git/` may import it.)
 * - **`message`** — `PageVersion.message` is the publisher's note about the change, which is
 *   what a **commit message** is for. Task 5 owns that, and putting it here as well would state
 *   one value in two parsers for no reader's benefit.
 * - **`searchText` and `searchHeadings`** — derived from the body that follows them in the same
 *   file. Mirroring a derivation of the document *into* the document invites the two to
 *   disagree, invisibly.
 * - **`pageId`, `authorId`** — the mirror is write-only (Phase 5 does not read it back), so an
 *   identifier is here for a human tracing a file to the application. `version` does that and
 *   resolves the page in the same query; a second opaque cuid would be noise in every diff.
 * - **`Page.status`, `Page.title`** — the version's copies are the ones that belong to this
 *   text. The page's are whatever the *latest* publish set.
 *
 * ## Frontmatter that does not parse is still stripped
 *
 * `splitFrontmatter` has a failure branch, and this function reads `body` on both — the same
 * choice `searchTextOf` makes, and the reason `FrontmatterResult` carries `body` either way.
 *
 * It is not the lazy reading. `body` is sliced from the parsed node's `position.end.offset`
 * *before* any cap or YAML error is evaluated, so it is the text after the author's block on
 * both branches: there is no arrangement of input where ignoring `ok` leaves the author's
 * frontmatter sitting in the mirrored body. Refusing instead would be defensible if the failure
 * meant the document was broken — but publish validated this frontmatter before storing it, so
 * the way a stored version reaches the failure branch is a **cap being lowered afterwards**, and
 * `renderMarkdown` strips the block for the reader regardless of any cap. Refusing would then
 * leave the mirror missing a page that renders perfectly, for a reason that has nothing to do
 * with the page. The one outcome that is not defensible — a mirrored file with the author's
 * frontmatter still in its body, under a canonical block that contradicts it — is the one this
 * cannot produce.
 *
 * ## The round trip, and where it stops
 *
 * `splitFrontmatter(mirrorDocumentOf(v))` returns exactly the values that went in, which is the
 * test that can fail on an injected key where a "the file contains the title" assertion cannot.
 * Two honest limits on that property, neither of which costs anything operationally because
 * nothing reads the mirror back:
 *
 * - The block is depth **4** at its deepest (`declared` → `relations` → a key → its items)
 *   against a `MAX_FRONTMATTER_DEPTH` of 6, so there is one level of headroom and not much more.
 * - `MAX_FRONTMATTER_BYTES` and `MAX_FRONTMATTER_ENTRIES` bound what the *reader* accepts, and
 *   this block is the author's accepted frontmatter **plus** nine canonical keys. A version
 *   whose frontmatter sat just under the 200-entry cap therefore mirrors to a block just over
 *   it, and `splitFrontmatter` would refuse to read its own output. That bounds what a test can
 *   assert, not what the mirror can write.
 *
 * ## No blank line between the block and the body
 *
 * The plan's Task 1 says "the canonical block, then a blank line, then the body", and that is
 * one line too many. `splitFrontmatter` removes exactly the line ending that terminates the
 * closing fence and nothing else, so an author's own blank line after their `---` is already
 * part of `body` — which is the usual document. Adding another would give the common case two
 * blank lines, and it would cost the clean property this module is otherwise able to hold: the
 * mirrored body is the stored body, byte for byte. The separator is whatever the author wrote,
 * because that is what the reader's renderer was given too.
 *
 * ## Control characters
 *
 * Not stripped here, and the claim that they are already gone needed checking rather than
 * repeating: `stripControl` runs on `title` at every boundary user input can enter through
 * (`draftSaveInput`, `createPage`, `publishPage` — and nothing else writes a title except the
 * seed), so C0/C1 cannot be in the column — **except
 * the three it deliberately keeps**, newline, tab and carriage return, and `publishPage` only
 * `trim()`s the ends. So a title containing an interior newline is a reachable stored value, not
 * a hypothetical, which is why the hostile-input tests use one. YAML handles all three: a
 * newline turns the scalar into an indented block literal, and a tab or a return into a
 * double-quoted `\t` or `\r` escape. Every one of them round trips.
 */

/**
 * One published version, flattened into the fields the mirror writes.
 *
 * Deliberately **not** a Prisma model. It is defined here so this module is pure and so a test
 * can build one from a literal, and the shape is flat because the fields come from three tables:
 * `title`, `markdown`, `frontmatter`, `status`, `publishedAt` and the author from `PageVersion`,
 * `path` and `docType` from `Page`, and the key from `Space`. Assembling it is the caller's job,
 * with an explicit `select:` like every other query in this project.
 */
export type MirroredVersion = {
  /** `PageVersion.id`. */
  versionId: string;
  /** `PageVersion.title` — user-controlled, and this is one of the two parsers it lands in. */
  title: string;
  /** `PageVersion.markdown` — the author's whole document, their frontmatter text included. */
  markdown: string;
  /** `PageVersion.frontmatter` — what validation accepted, written out under `declared`. */
  frontmatter: FrontmatterValue;
  /** `PageVersion.status`. */
  status: DocStatus;
  /** `PageVersion.createdAt`, not `Page.publishedAt`. See the module note. */
  publishedAt: Date;
  /** The publisher: `PageVersion.author`'s `name` and `email`. */
  author: { name: string; email: string };
  /** `Space.key`. */
  spaceKey: string;
  /** `Page.path`, space-relative and without an extension. */
  path: string;
  /** `Page.docType`. */
  docType: DocType;
};

/**
 * The mirrored file for one published version: a canonical frontmatter block, then the author's
 * body with the author's own frontmatter removed.
 *
 * Deterministic — the same values produce byte-identical output, including across two objects
 * that are equal but not identical, which is what `aliasDuplicateObjects: false` buys. A mirror
 * that churns produces diffs for content nobody changed.
 *
 * The body is passed through unaltered but for one byte: a final newline is added when the
 * stored document lacks one. That is the only normalisation, and it is the difference between a
 * text file and one whose last line every future diff reports as changed.
 */
export function mirrorDocumentOf(version: MirroredVersion): string {
  const block = serializeFrontmatter({
    title: version.title,
    space: version.spaceKey,
    path: version.path,
    docType: version.docType,
    status: version.status,
    version: version.versionId,
    // Rebuilt from the two fields rather than passed through, so a field added to
    // `MirroredVersion["author"]` later cannot start appearing in every mirrored file without
    // this line changing.
    author: { name: version.author.name, email: version.author.email },
    // A string, not the `Date`: `yaml` writes a `Date` as an unquoted ISO timestamp and reads it
    // back as a **string** under YAML 1.2's core schema, so passing the object would be a round
    // trip that changes type. Formatting it here makes the value explicit and UTC.
    publishedAt: version.publishedAt.toISOString(),
    declared: version.frontmatter,
  });

  // `body` on both branches — see the module note. Nothing here reads `frontmatter` from the
  // split: the canonical block above comes from the column, which is the normalised value, and
  // re-parsing the author's text would be a second, disagreeing source for it.
  const { body } = splitFrontmatter(version.markdown);

  return body.endsWith("\n") ? `${block}${body}` : `${block}${body}\n`;
}
