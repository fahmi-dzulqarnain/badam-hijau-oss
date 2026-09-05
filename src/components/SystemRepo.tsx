import { REPO_WITHHELD_SENTENCE, type RepoLink } from "@/lib/systems/repo-url";

/**
 * A system's repository, rendered in the one way both `/systems` and `/systems/[key]` render it.
 *
 * Shared rather than written twice, and the reason is the project's own: *"a rule implemented in
 * two places is not yet a convention"* — the draft-is-inert rule and the path-encoding rule were
 * each honoured by two link sites and quietly dropped by the third. The rule here is that a
 * stored URL is **never** interpolated into an `href` or into text without `repoLinkOf` having
 * said it may be, so it lives in one component and takes a `RepoLink` rather than a string. A
 * caller cannot pass `system.repoUrl` to this: the type will not allow it.
 *
 * `rel="noreferrer"` and `target="_blank"`: the destination is an external host an admin typed,
 * so it opens away from the reader and is not told where the reader came from.
 *
 * `.sys-repo` carries `overflow-wrap: anywhere` — a repository URL is a long token with few break
 * opportunities, painted outside `.body`, which is the shape that has widened this application
 * eight times.
 */
export function SystemRepo({ repo }: { repo: RepoLink }) {
  if (repo.kind === "absent") {
    return (
      <span className="sys-repo sys-repo-none">
        No repository recorded
      </span>
    );
  }
  if (repo.kind === "withheld") {
    return <span className="sys-repo sys-repo-held">{REPO_WITHHELD_SENTENCE[repo.reason]}</span>;
  }
  return (
    <a className="sys-repo" href={repo.href} target="_blank" rel="noreferrer">
      {repo.href}
    </a>
  );
}
