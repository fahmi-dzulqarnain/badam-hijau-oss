/**
 * Whether a stored `System.repoUrl` may be rendered as a link — and if not, why not.
 *
 * Pure: a string in, a decision out, nothing imported from Prisma, so every rule here is
 * unit-testable without a database.
 *
 * ## This is one half of a two-ended fix, and the other half is Task 5's
 *
 * Phase 5 Task 8's finding was that a credential reaches a column through **the string this
 * application builds and stores**, not through the tool's stderr — and Task 1 recorded the same
 * channel arriving here: `git remote -v` in the real checkouts on this machine prints
 * `https://oauth2:glpat-…@gitlab.…/…`, which is exactly what an admin would paste into Task 5's
 * form. `/systems` and `/systems/[key]` render `repoUrl` to **every signed-in reader**, so a
 * pasted token would be a link in an anchor's `href` and a string in the page's text.
 *
 * Phase 5's lesson was that removing either end alone still leaks, so this end exists whether or
 * not Task 5's write refusal does: **a URL carrying userinfo is neither linked nor printed.** Not
 * redacted, not shown with the password starred — *not printed at all*, because a redaction is a
 * transformation of a secret and this surface has no reason to hold one. The system's name, kind,
 * owner and description are unaffected; only the repository line changes, and it says why.
 *
 * ## `username` alone is enough to withhold, and that is the case that matters
 *
 * `https://oauth2:<token>@host` is the form with two components, but the common single-component
 * form is `https://<token>@host` — a personal access token as the *username* with no password at
 * all. A rule that only looked for a password would pass that straight through, which is the
 * "reproduce the class, not the instance" failure this project has recorded three times. So a
 * non-empty `username` **or** a non-empty `password` withholds.
 *
 * The cost is a false positive that is worth naming: `https://git@host/repo.git` is a legal
 * remote whose username is not a secret. It is withheld too, and the sentence the surface renders
 * says what to do about it — an admin re-enters the URL without the userinfo, which is the same
 * URL. There is no way to tell a token from a login name by looking at one, and the direction to
 * fail in is obvious.
 *
 * ## The scheme is an allowlist, and it is a second defect, not a variant of the first
 *
 * `repoUrl` is unvalidated on write until Task 5, so the column can hold `javascript:alert(1)` —
 * which in an `href` is script execution, not a broken link. React does not stop it for a
 * runtime-computed string. So the protocol is checked against `http:`/`https:` rather than
 * against a denylist of the schemes anyone thought of. `ssh://git@host/x.git` and
 * `git@host:x.git` both fail here too, correctly: neither is something a browser can follow.
 *
 * **Scheme is tested before userinfo**, which decides only which reason is reported when both are
 * wrong. `ssh://git@gitlab…` is a perfectly ordinary remote whose `git@` is not a credential, and
 * calling it a credential leak would be a false alarm on the honest case; the reason it cannot be
 * linked is that it is not a web URL.
 */

/** Why a stored URL is not being offered as a link. Each one renders a different sentence. */
export type RepoWithheldReason =
  /** `username` or `password` is set — `https://oauth2:<token>@host`, or a bare token. */
  | "credentials"
  /** Parsed, but not `http:` or `https:` — an `ssh://` remote, or a `javascript:` URL. */
  | "scheme"
  /** `new URL` refused it: a relative path, `git@host:repo.git`, or a typo. */
  | "unparseable";

export type RepoLink =
  /** Safe to render as an anchor. `href` is the parsed, normalised form. */
  | { kind: "link"; href: string }
  /** The column is null or blank — three of the seven seeded systems, deliberately. */
  | { kind: "absent" }
  /** Stored, and deliberately not rendered. Nothing of the URL leaves this module. */
  | { kind: "withheld"; reason: RepoWithheldReason };

/**
 * The one decision, taken in one place so the index page and the system page cannot disagree.
 *
 * Returns `absent` for a blank string as well as for `null`: the difference between a column
 * nobody filled in and one holding three spaces is not a difference a reader can act on, and an
 * anchor whose text is whitespace is an invisible link.
 */
export function repoLinkOf(raw: string | null | undefined): RepoLink {
  if (raw === null || raw === undefined || raw.trim() === "") return { kind: "absent" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "withheld", reason: "unparseable" };
  }

  // Allowlist, and first — see the docstring for why the order decides only the reason.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "withheld", reason: "scheme" };
  }
  // Either component, not both: `https://<token>@host` is the form with no password.
  if (url.username !== "" || url.password !== "") {
    return { kind: "withheld", reason: "credentials" };
  }

  // `url.href`, not `raw`: the parsed form is the one whose scheme and userinfo were just
  // checked, so nothing that was inspected can differ from what is rendered.
  return { kind: "link", href: url.href };
}

/**
 * What the surface says instead of a link. Here rather than in the components, because both
 * surfaces render it and a sentence duplicated in two files is a sentence that disagrees with
 * itself after the next edit.
 *
 * The credential sentence deliberately does **not** repeat the URL, in any form.
 */
export const REPO_WITHHELD_SENTENCE: Record<RepoWithheldReason, string> = {
  credentials:
    "The stored repository URL embeds a username or password, so it is not shown or linked. " +
    "An admin should re-enter it without the credentials — and rotate the token, because it " +
    "has been sitting in the catalogue.",
  scheme:
    "The stored repository URL is not an http or https address, so it cannot be opened from " +
    "here. An admin can replace it with the browsable one.",
  unparseable: "The stored repository URL is not a URL, so it is not linked.",
};
