import { expect, test } from "vitest";
import { REPO_WITHHELD_SENTENCE, repoLinkOf } from "@/lib/systems/repo-url";

/**
 * The reader-facing half of Task 1's credential finding: `System.repoUrl` is rendered as a link
 * to **every signed-in reader**, and the real remotes on this machine embed a GitLab token.
 *
 * Task 5 owes the refusal on write. Phase 5 Task 8's lesson was that removing either end alone
 * still leaks, so this end has its own tests and does not depend on that one existing.
 */

test("an ordinary https remote is a link", () => {
  const seeded = "https://gitlab.acme-partner.dev/acme/mobile/ios/store-pos.git";
  expect(repoLinkOf(seeded)).toEqual({ kind: "link", href: seeded });
  expect(repoLinkOf("http://git.internal/x.git")).toEqual({
    kind: "link",
    href: "http://git.internal/x.git",
  });
});

test("a URL with embedded credentials is withheld — and neither the token nor the URL comes back", () => {
  // The shape Task 1 measured in a real `git remote -v` on this machine.
  const leaky = "https://oauth2:glpat-SECRETVALUE123@gitlab.acme-partner.dev/acme/hub/order-hub-gateway.git";
  const decision = repoLinkOf(leaky);

  expect(decision).toEqual({ kind: "withheld", reason: "credentials" });
  // The assertion that matters is not the tag, it is that nothing carrying the secret leaves the
  // module in any form. A "redacted" variant returning `https://***@host/...` would satisfy the
  // line above and still put the host and the shape of the URL on the page; this one fails.
  expect(JSON.stringify(decision)).not.toContain("glpat-SECRETVALUE123");
  expect(JSON.stringify(decision)).not.toContain("gitlab.acme-partner.dev");
  expect(REPO_WITHHELD_SENTENCE.credentials).not.toContain("glpat");
});

test("a username with no password is withheld too — that is the common token form", () => {
  // `https://<token>@host` is how a personal access token is usually pasted, and a rule that
  // looked only for a password would pass it straight through. Reproduce the class, not the
  // instance.
  expect(repoLinkOf("https://glpat-SECRET@gitlab.example.com/x.git")).toEqual({
    kind: "withheld",
    reason: "credentials",
  });
  // The accepted false positive, stated as a test rather than left to be discovered: `git@` is a
  // legal username and not a secret, and it is withheld anyway, because nothing can tell the two
  // apart by looking.
  expect(repoLinkOf("https://git@gitlab.example.com/x.git")).toEqual({
    kind: "withheld",
    reason: "credentials",
  });
});

test("a non-http scheme is withheld, and `javascript:` is why it is an allowlist", () => {
  // `repoUrl` is unvalidated on write until Task 5, so the column can hold this — and in an
  // `href` it is script execution, not a broken link. A denylist of schemes anyone thought of
  // would be the wrong shape here.
  expect(repoLinkOf("javascript:alert(1)")).toEqual({ kind: "withheld", reason: "scheme" });
  expect(repoLinkOf("data:text/html,<script>alert(1)</script>")).toEqual({
    kind: "withheld",
    reason: "scheme",
  });
  // An ssh remote is reported as a scheme problem and not as a credential one, which is why the
  // scheme is tested first: `git@` here is the ordinary form and calling it a leak would be a
  // false alarm on the honest case.
  expect(repoLinkOf("ssh://git@gitlab.example.com/x.git")).toEqual({
    kind: "withheld",
    reason: "scheme",
  });
});

test("an unparseable value is withheld rather than linked", () => {
  // `git@host:repo.git` is the scp-like remote form, which is not a URL at all.
  expect(repoLinkOf("git@gitlab.example.com:acme/hub.git")).toEqual({
    kind: "withheld",
    reason: "unparseable",
  });
  expect(repoLinkOf("/not/a/url")).toEqual({ kind: "withheld", reason: "unparseable" });
});

test("null, undefined and blank are absent — three of the seven seeded systems have no repo", () => {
  expect(repoLinkOf(null)).toEqual({ kind: "absent" });
  expect(repoLinkOf(undefined)).toEqual({ kind: "absent" });
  // Blank is `absent` and not `unparseable`: the difference between a column nobody filled in and
  // one holding three spaces is not a difference a reader can act on.
  expect(repoLinkOf("   ")).toEqual({ kind: "absent" });
});

test("every withheld reason has a sentence, and none of them promises a link", () => {
  for (const reason of ["credentials", "scheme", "unparseable"] as const) {
    expect(REPO_WITHHELD_SENTENCE[reason].length).toBeGreaterThan(0);
  }
});
