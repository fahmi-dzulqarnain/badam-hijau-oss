import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { listBugReports, parseBugStatusFilter } from "@/lib/bugs/admin";
import { ADMIN_BUGS_PATH } from "@/lib/pages/href";
import { AdminBugs } from "@/components/AdminBugs";

/**
 * `/admin/bugs` — spec §11's fourth administration surface and §18.2's *"listed for admins at
 * `/admin/bugs`"*, Phase 7 Task 8.
 *
 * **This is the other end of a button Phase 1 shipped.** The rail's *Report bug* control has been
 * writing `BugReport` rows since the first phase and nothing has ever read one back — the closest
 * anything came was `e2e/support.ts` counting them to prove a spec cleaned up after itself. So the
 * table has real rows in it, written by a schema decision that expects readers to cope with
 * dangling ids, and this route is the first reader.
 *
 * Thin, exactly as the three admin routes beside it: `requireViewer` sends a signed-out visitor to
 * sign in, `listBugReports` decides everything else, and a refusal renders `notFound()`. **Two
 * guards refusing two different people**, each separately killable — delete the redirect and a
 * signed-out visitor gets a crash instead of a sign-in page; delete `refuseNonAdmin` and every
 * signed-in person reads every reporter's email address and every route they were on.
 *
 * The refusal is `notFound()` and never a `403`: `src/lib/admin/gate.ts` carries the argument.
 *
 * ## The filter is a query string, and that is deliberately not a segment
 *
 * `?status=NEW` rather than `/admin/bugs/new`. A filtered list is a *view* of one resource and not
 * a resource of its own, so a status in the path would invent three routes, three more paths in
 * the `admin` collision window, and a 404 for a value that is merely unknown. The parse is
 * `parseBugStatusFilter`, which ignores anything it does not recognise rather than refusing —
 * `?status=banana` shows the unfiltered list, because a query string is not an identity.
 *
 * ## The route collision, and this is the fourth and last leaf
 *
 * `/admin/bugs` is **fully static** — two literal segments, no dynamic one, and `searchParams` are
 * not segments — so `routes-manifest.json` puts it in `staticRoutes` and adds nothing to
 * `dynamicRoutes`. Task 5's measured class: a space keyed `admin` loses exactly this one further
 * path and keeps its landing page, because there is still no `/admin/page.tsx`. The window is
 * closed going forward by `validateSpaceKey`, and no space is keyed `admin` today.
 *
 * ## Overflow
 *
 * Every value on this page except a status chip and two timestamps is text a person typed or a
 * browser pasted, and one of them — `consoleError` — is bounded at **5000 characters** of
 * arbitrary console output. That is the ninth overflow shape at a scale none of the eight before
 * it had; `.rep-console` and `.rep-ua` carry the guards and `e2e/admin-bugs.spec.ts` measures them
 * against a 5000-character unbreakable token rather than hoping the corpus contains one.
 */
export default async function AdminBugsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const viewer = await requireViewer(ADMIN_BUGS_PATH);
  const status = parseBugStatusFilter((await searchParams).status);

  const result = await listBugReports(viewer, { status });
  if (!result.ok) notFound();

  return (
    <main className="doc">
      <h1>Bug reports</h1>
      <p className="sys-lead">
        Spec §18.2&rsquo;s in-product reports, as they arrive from the rail&rsquo;s{" "}
        <em>Report bug</em> button. This is a signal channel and not a support system: there are no
        replies and no notifications, and the three states below are the whole vocabulary — whether
        anybody has looked at a report, and whether it is still open.
      </p>
      <p className="adm-note">
        A report keeps the space, page and version it was filed against as <em>captured ids</em>,
        deliberately without foreign keys, because they are worth most when the page is gone. So a
        row here can name a page that has been taken down — recoverable — or one that no longer
        exists at all, and it says which. The route is the breadcrumb that survives both.
      </p>

      <AdminBugs
        reports={result.reports}
        truncated={result.truncated}
        counts={result.counts}
        status={result.status}
      />
    </main>
  );
}
