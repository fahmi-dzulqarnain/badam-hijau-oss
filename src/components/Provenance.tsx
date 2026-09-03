import type { Route } from "next";
import Link from "next/link";
import {
  CONTENT_COMMIT_LABEL,
  NOT_MIRRORED,
  shortSha,
} from "@/lib/version/labels";

/**
 * A content sha, short on the page and whole in the tooltip.
 *
 * A git object name is 40 characters with no break opportunity in it, which is the shape that
 * has widened this application's layout six times — and unlike a title or an author name it
 * cannot be *wrapped* into safety either, because `overflow-wrap: anywhere` on a 40-character
 * token in a 12.5px monospace still demands ~300px of one line before it breaks. So the value
 * shown is `SHA_DISPLAY_LENGTH` characters and the full one is a `title` attribute, which is
 * available on hover and costs no layout width at any viewport.
 *
 * `.sha` still carries `overflow-wrap: anywhere` in `doc.css`. Ten characters cannot overflow
 * anything this page has, so that is a guard against a future longer form rather than a
 * live need — stated because a reader of the CSS would otherwise delete it as dead.
 */
export function Sha({ value }: { value: string }) {
  return (
    <code className="sha" title={value}>
      {shortSha(value)}
    </code>
  );
}

/**
 * The reader route's provenance pair: which content commit holds this text, and the link to the
 * rest of the page's versions (spec §10 — "surfaces the published commit sha on the page and
 * links to version history, so provenance is visible and a broken mirror is noticed").
 *
 * ## Both halves are in `.meta` and neither is in the right rail
 *
 * `doc.css` hides `.rail-r` entirely below 1180px, so a `PageInfoCard` row would simply not
 * exist on a laptop in a split window — the same shape of bug as Phase 1's bug dialog, which
 * lived inside `.rail-l` and vanished with it below 860px, taking the user's typed text along.
 * `.meta` is hidden at no width. The rail's "Versions" count is deliberately left as a count and
 * not turned into a second link: an affordance that appears and disappears with the viewport is
 * how a reader learns a feature exists and then cannot find it.
 *
 * ## The link is rendered in every state, including the unmirrored one
 *
 * The history page is where a null sha is explained, so it must be reachable from the page whose
 * sha is null — which is every page published before Phase 5. A link offered only when there is
 * a sha would be absent from exactly the pages a reader has a question about.
 *
 * ## What it does NOT show
 *
 * Whether *this* version's mirror job failed. That is a `GitJob` read, and the reader route is
 * the hottest path in the product — a query on every page view to report a state that is
 * normally empty. It is also, on its own, a claim that cannot be made truthfully per version: a
 * page's queue can be wedged by a failed `MOVE` job that carries no version at all, in which
 * case the newest version's own job is `PENDING` behind it and "queued" and "failed" are both
 * half-true. `listPageVersions` says it once, about the page, on a surface someone opened
 * deliberately.
 */
export function ContentCommit({
  gitSha,
  historyHref,
}: {
  gitSha: string | null;
  historyHref: Route;
}) {
  return (
    <>
      <span>
        <span
          className="k"
          title="The commit in the content repository that mirrors this version of the page"
        >
          {CONTENT_COMMIT_LABEL}
        </span>{" "}
        {/* A value, never an empty gap: an absent sha is a normal state and reads as one. */}
        {gitSha === null ? NOT_MIRRORED : <Sha value={gitSha} />}
      </span>
      <Link className="doc-history" href={historyHref}>
        Version history
      </Link>
    </>
  );
}
