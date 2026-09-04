import { expect, test } from "vitest";
import { REDACTED, redactCredentials } from "./redact";

/**
 * The credential redactor.
 *
 * Every absence assertion here has a companion that proves the surrounding text survived —
 * `redactCredentials(x) => ""` would pass every "does not contain the token" assertion in this
 * file on its own, which is exactly the vacuity this project has recorded four times.
 */

/** A token shaped like the thing that is actually leaked: a GitHub PAT. */
const TOKEN = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";

test("a password in a remote URL is replaced, and the host and path are kept", () => {
  const redacted = redactCredentials(
    `Pushing to the content remote: git exited 128. Output: fatal: Authentication failed for ` +
      `'https://badam:${TOKEN}@github.example/org/repo.git/'`,
  );

  expect(redacted).not.toContain(TOKEN);
  // Non-vacuity: the message is still a message, and it still names which remote refused.
  expect(redacted).toContain("Authentication failed");
  expect(redacted).toContain("github.example/org/repo.git");
  expect(redacted).toContain(`https://${REDACTED}@github.example`);
});

test("a token in the username position goes too — the shape a PAT actually takes", () => {
  // The half a "redact the password" rule would keep: a PAT carries no colon at all.
  const redacted = redactCredentials(`https://${TOKEN}@github.example/org/repo.git`);

  expect(redacted).not.toContain(TOKEN);
  expect(redacted).toBe(`https://${REDACTED}@github.example/org/repo.git`);
});

test("a password containing a literal @ is removed whole, not up to its first @", () => {
  // The greedy-match case. A lazy `[^/?#\s]*?@` leaves `ss@host` behind, publishing half the
  // password — which is the failure this test exists to pin, because both versions pass the
  // assertion above.
  const redacted = redactCredentials("https://user:p@ssw0rd@github.example/org/repo.git");

  expect(redacted).toBe(`https://${REDACTED}@github.example/org/repo.git`);
  expect(redacted).not.toContain("ssw0rd");
  expect(redacted).not.toContain("p@ss");
});

test("every occurrence in one message is redacted, not just the first", () => {
  // A real push failure names the remote twice: once in the argv this application built and once
  // in git's own output. A pattern without `g` would clean the argv and publish the echo.
  const redacted = redactCredentials(
    `Command: ["push","--","https://u:${TOKEN}@h/r.git","HEAD:refs/heads/main"]. ` +
      `Output: fatal: repository 'https://u:${TOKEN}@h/r.git/' not found`,
  );

  expect(redacted).not.toContain(TOKEN);
  expect(redacted.match(/\[redacted\]/g)).toHaveLength(2);
  // Non-vacuity: the operator can still see which command was run and what git said.
  expect(redacted).toContain('"push","--"');
  expect(redacted).toContain("not found");
});

test("the pattern does not carry lastIndex between calls", () => {
  // `URL_USERINFO` is a module-level literal with the `g` flag. `replace` resets `lastIndex`
  // and `test`/`exec` do not, so this pins the one that is used — a stateful regex would make
  // every other call a silent no-op, which no single-call test can see.
  const one = `https://a:${TOKEN}@h/r.git`;
  expect(redactCredentials(one)).toBe(redactCredentials(one));
  expect(redactCredentials(one)).not.toContain(TOKEN);
});

test("a URL with no credentials is returned unchanged", () => {
  const plain = "Cloning the content repository: git exited 128. Output: fatal: could not read from remote https://github.example/org/repo.git";
  expect(redactCredentials(plain)).toBe(plain);
});

test("an scp-style remote is left alone, because it has no password field", () => {
  // `git@github.com:org/repo.git` — the text before the `@` is a login name and cannot be a
  // secret. Redacting it would remove information for nothing.
  const scp = "Pushing to the content remote: git exited 128. Command: [\"push\",\"--\",\"git@github.example:org/repo.git\"]";
  expect(redactCredentials(scp)).toBe(scp);
  expect(redactCredentials(scp)).toContain("git@github.example");
});

test("an email address in prose is not a URL and is not touched", () => {
  // Every mirrored commit carries an author email, and a git failure can quote one. `me@x.org`
  // has no `://` before it, so nothing matches — stated as a test because a redactor that ate
  // the author's address would make an attribution failure unreadable.
  const prose = "Committing: git exited 128. Output: fatal: empty ident name for <aisyah@example.com>";
  expect(redactCredentials(prose)).toBe(prose);
});

test("an ssh:// remote's login name is redacted, which is the accepted cost", () => {
  // `ssh://git@host/x` carries no secret, but nothing in the text distinguishes `git` from a
  // token in the same position, so it goes. Pinned so the behaviour is a decision rather than a
  // surprise, and so the host — the useful half — is asserted to survive.
  expect(redactCredentials("ssh://git@github.example/org/repo.git")).toBe(
    `ssh://${REDACTED}@github.example/org/repo.git`,
  );
});

test("the empty string and text with no URL at all are total", () => {
  expect(redactCredentials("")).toBe("");
  expect(redactCredentials("nothing to commit, working tree clean")).toBe(
    "nothing to commit, working tree clean",
  );
});
