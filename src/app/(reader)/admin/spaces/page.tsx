import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { ADMIN_SPACES_PATH } from "@/lib/pages/href";
import { listSpacesForAdmin } from "@/lib/spaces/admin";
import { AdminSpaces } from "@/components/AdminSpaces";

/**
 * `/admin/spaces` — spec §11's `/admin/*`, Phase 7 Task 6. **The first surface in this product
 * that creates a `Space`.**
 *
 * Thin, exactly as `/admin/systems` is and for the same reason: `requireViewer` sends a signed-out
 * visitor to sign in, `listSpacesForAdmin` decides everything else, and a refusal renders
 * `notFound()`. Two guards, refusing two different people, each separately killable — delete the
 * redirect and a signed-out visitor gets a crash instead of a sign-in page; delete
 * `refuseNonAdmin` and every signed-in person administers the installation.
 *
 * The refusal is `notFound()` and not a `403`: `src/lib/admin/gate.ts` carries the argument, and on
 * *this* route it is doing the most work of any of the four, because a `403` from `/admin/spaces`
 * would tell an ordinary member both that space administration exists and that they are not it.
 *
 * ## The route collision, and this is the leaf that closes the window it widens
 *
 * `/admin/spaces` is **fully static** — two literal segments, no dynamic one — so
 * `routes-manifest.json` puts it in `staticRoutes` and adds nothing to `dynamicRoutes`. That is
 * Task 5's measured shape: a space keyed `admin` loses **exactly this one further path** and keeps
 * its landing page and everything else, which is the `/-/mirror` shape — Phase 5 Task 8's
 * measurement, on a route Task 7 has since absorbed into `/admin/git` — rather than
 * `/systems/[key]`'s, where a dynamic segment ahead of `/[space]` swallowed every depth-one path
 * and 404ed rather than falling through.
 *
 * The difference from every route before it is that this one is where the window shuts.
 * `validateSpaceKey` refuses `admin`, `api`, `edit`, `new`, `search` and `systems` for any key
 * typed from here on — and `-`, by shape rather than by that list, which is where Task 7 left it
 * when absorbing `/-/mirror` gave the segment back —, and `Space_key_shape` makes the character class the column's own. Neither is
 * retroactive: see `src/lib/spaces/key.ts` for exactly what a key created earlier can still do. No
 * space is keyed `admin` today, and there is still deliberately no `/admin/page.tsx` — the
 * cross-links live in the layout, which creates no route.
 *
 * ## Overflow
 *
 * Every string on this page is typed by a person — a space's key, name, initials and description
 * by an admin, and behind the "Members" control a name and an email address by an identity
 * provider. All of them are painted **outside** `.body`. The page reuses `.sys-row`, `.sys-head`,
 * `.sys-meta` and `.sys-key` rather than growing parallel rules, so it inherits the guards Task 3's
 * ninth shape earned; `flex: none` is reserved here for the values something other than a person
 * bounds — the visibility chip and the two counts. `e2e/admin-spaces.spec.ts` measures the class
 * with `HOSTILE` rather than with the seeded corpus.
 */
export default async function AdminSpacesPage() {
  const viewer = await requireViewer(ADMIN_SPACES_PATH);

  const result = await listSpacesForAdmin(viewer);
  if (!result.ok) notFound();

  return (
    <main className="doc">
      <h1>Manage spaces</h1>
      <p className="sys-lead">
        Every space in this installation, and who is in it. Membership is what grants read, edit
        and publish — a space&rsquo;s visibility and its member list are the whole answer to who
        can open its documents.
      </p>
      <AdminSpaces spaces={result.spaces} />
    </main>
  );
}
