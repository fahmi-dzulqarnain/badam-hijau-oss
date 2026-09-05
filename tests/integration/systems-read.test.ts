import { beforeEach, expect, test } from "vitest";
import type { DocStatus, DocType } from "@prisma/client";
import { db, resetDb } from "../setup/reset";
import { inOneRequest } from "@/lib/audit/log";
import { saveDraft } from "@/lib/drafts/repo";
import { publishPage } from "@/lib/pages/publish";
import { CLOSED_RFC_STATUSES, OPEN_RFC_STATUSES } from "@/lib/systems/groups";
import {
  getSystemDocumentation,
  listSystems,
  type SystemDocGroup,
  type SystemDocsResult,
} from "@/lib/systems/read";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Task 3's two reads, against the real database.
 *
 * **The file is written around one claim**, because it is the phase's landmine: `/systems/[key]`
 * is the first read in this product that is not scoped to a space the URL names, so without a
 * readable-space filter in the query it enumerates every page title and path in the installation
 * to anyone signed in.
 *
 * The rule the permission tests are written to, from the plan and from Phase 4's own correction:
 * **a discrimination, not an absence.** "A non-member sees nothing" is near-vacuous here for the
 * same reason it was for search — a viewer who reads no space gets an empty list whether the
 * filter discriminates or not, and an empty list is also what a broken query returns. So the
 * fixture gives two viewers one readable space each, puts a page declaring the *same* system in
 * both, and asserts that each viewer sees their own and not the other's. Both lists are non-empty
 * in the same assertion, which is what makes "absent" mean something.
 *
 * Every exclusion test below has a non-vacuity companion showing the same query returning the
 * same page for someone, or at some moment, that it should.
 */

/** Distinguishable per space, so a row attributed to the wrong space is visible in the failure. */
const ALPHA_TITLE = "Bunkering runbook (alpha)";
const BETA_TITLE = "Gantry reconciliation (beta)";

async function fixture() {
  const aisyah = await db.user.create({ data: { email: "aisyah@example.com", name: "Aisyah R." } });
  const budi = await db.user.create({ data: { email: "budi@example.com", name: "Budi S." } });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const nobody = await db.user.create({ data: { email: "stranger@example.com", name: "Nobody" } });

  // Two MEMBERS spaces with one member each — the shape the discrimination needs — and one
  // ALL_STAFF space so a viewer who belongs to nothing can still see *something*, which is what
  // stops the stranger's assertions being about a viewer with no readable space at all.
  const alpha = await db.space.create({
    data: { key: "alpha", name: "Alpha", initials: "AL", visibility: "MEMBERS" },
  });
  const beta = await db.space.create({
    data: { key: "beta", name: "Beta", initials: "BE", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: alpha.id, userId: aisyah.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({ data: { spaceId: beta.id, userId: budi.id, role: "EDITOR" } });

  // `memberships` names the real rows: `can()` reads this in-memory list while `readableSpace`
  // filters on the `SpaceMembership` row, deliberately (PROGRESS), so a synthetic membership
  // reads nothing.
  const asAisyah: Viewer = {
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: alpha.id, role: "EDITOR" }],
  };
  const asBudi: Viewer = {
    id: budi.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: beta.id, role: "EDITOR" }],
  };
  /** A super admin who belongs to nothing — §8's audited case. */
  const asRoot: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };
  /** A member of nothing. `handbook` is `ALL_STAFF`, so they can still read one space. */
  const asStranger: Viewer = { id: nobody.id, isSuperAdmin: false, memberships: [] };

  // Named after the seven §7 systems `prisma/seed.ts` creates rather than invented keys, for the
  // reason `publish.test.ts`'s `catalogue()` gives: a fixture cannot then pass on a key the
  // product does not have. `resetDb` truncates `System` with everything else.
  const hubCore = await db.system.create({
    data: {
      key: "order-hub",
      name: "Order hub",
      kind: "LIBRARY",
      ownerTeam: "Hub",
      repoUrl: "https://git.acme-corp.dev/acme/hub/order-hub-gateway.git",
    },
  });
  const posIos = await db.system.create({
    data: { key: "store-ios", name: "Acme Store (iOS)", kind: "MOBILE_APP" },
  });

  /**
   * A published page that names a system.
   *
   * The version row and the facet row are written directly rather than through `publishPage`,
   * and the reason is which module is under test: this file is about a *read*, and the
   * authoring path that produces these rows is Task 2's, tested in `publish.test.ts` against
   * every rule it owns. Going through publish here would also make several of the cases below
   * unreachable without three round trips each — an ADR at `SUPERSEDED` is two publishes and a
   * cascade — for statuses this query only ever compares.
   *
   * One test below does drive a real publish end to end, so the two halves are joined somewhere.
   */
  const documented = async (args: {
    spaceId: string;
    slug: string;
    title: string;
    docType?: DocType;
    status?: DocStatus;
    systemIds?: readonly string[];
    published?: boolean;
  }) => {
    const status = args.status ?? "CURRENT";
    const page = await db.page.create({
      data: {
        spaceId: args.spaceId,
        slug: args.slug,
        path: args.slug,
        title: args.title,
        docType: args.docType ?? "DOC",
        status,
        createdById: aisyah.id,
      },
      select: { id: true },
    });
    const version = await db.pageVersion.create({
      data: {
        pageId: page.id,
        title: args.title,
        markdown: `# ${args.title}\n`,
        status,
        authorId: aisyah.id,
      },
      select: { id: true },
    });
    if (args.published !== false) {
      await db.page.update({
        where: { id: page.id },
        data: { publishedVersionId: version.id, publishedAt: new Date("2026-09-01T09:00:00Z") },
      });
    }
    for (const systemId of args.systemIds ?? [hubCore.id]) {
      await db.pageSystem.create({ data: { pageId: page.id, systemId } });
    }
    return { id: page.id, versionId: version.id };
  };

  return {
    alpha,
    beta,
    handbook,
    aisyah,
    hubCore,
    posIos,
    asAisyah,
    asBudi,
    asRoot,
    asStranger,
    documented,
  };
}

/** Narrows to the success branch, failing with the actual result if it is not one. */
function found(result: SystemDocsResult) {
  if (!result.ok) throw new Error(`expected a system, got ${JSON.stringify(result)}`);
  return result;
}

/** Every listed title on the page, across all four groups, in render order. */
function titlesOf(result: SystemDocsResult): string[] {
  return found(result).groups.flatMap((group) => group.rows.map((row) => row.title));
}

function groupOf(result: SystemDocsResult, docType: DocType): SystemDocGroup {
  const group = found(result).groups.find((candidate) => candidate.docType === docType);
  if (group === undefined) throw new Error(`no ${docType} group — every doc type must have one`);
  return group;
}

/**
 * ## The discrimination — the test this task exists for
 *
 * Two members, two `MEMBERS` spaces, one system, one URL. Both viewers see a page and neither
 * sees the other's, asserted in the same test so "absent" cannot be confused with "empty".
 *
 * **The mutant it kills:** delete `{ space: readableSpace(viewer) }` from `pageScope` in
 * `src/lib/systems/read.ts`. Measured, and the failure is named rather than promised — see the
 * task's mutation record for the exact message.
 *
 * An absence assertion on `asStranger` would not kill it: a viewer with no readable space gets an
 * empty list from a query with no permission predicate too, because the pages simply are not
 * theirs to be told apart. That is the near-vacuity Phase 4 measured, and it is why this test is
 * written with two viewers who both read something.
 */
test("two viewers, one URL, two different lists — and both of them see something", async () => {
  const f = await fixture();
  await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });
  await f.documented({ spaceId: f.beta.id, slug: "beta-doc", title: BETA_TITLE });

  const forAisyah = await getSystemDocumentation(f.asAisyah, "order-hub");
  const forBudi = await getSystemDocumentation(f.asBudi, "order-hub");

  // Non-empty on both sides, which is what makes each exclusion below a discrimination.
  expect(titlesOf(forAisyah)).toEqual([ALPHA_TITLE]);
  expect(titlesOf(forBudi)).toEqual([BETA_TITLE]);
  // Said again as an exclusion, so a failure names which direction leaked.
  expect(titlesOf(forAisyah)).not.toContain(BETA_TITLE);
  expect(titlesOf(forBudi)).not.toContain(ALPHA_TITLE);

  // The counts are filtered too, and they are a second surface: a group total is rendered beside
  // the list, so an aggregate without the predicate would report "1 of 2" and tell a member of
  // alpha that a page exists in beta. `pageScope` is shared by both queries precisely so this
  // cannot diverge, and the assertion is here because the sharing is a decision.
  expect(groupOf(forAisyah, "DOC").total).toBe(1);
  expect(groupOf(forBudi, "DOC").total).toBe(1);

  // And the super admin, whose readable set is everything: the same URL, both pages. Without
  // this, a filter that returned nothing to everybody would pass the two assertions above.
  const forRoot = await inOneRequest(() => getSystemDocumentation(f.asRoot, "order-hub"));
  expect(titlesOf(forRoot).sort()).toEqual([ALPHA_TITLE, BETA_TITLE].sort());
  expect(groupOf(forRoot, "DOC").total).toBe(2);
});

test("a viewer who can read one space still sees the system, its metadata and empty groups", async () => {
  const f = await fixture();
  await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });

  // The stranger reads `handbook` and nothing else, so this is not a viewer who can see nothing —
  // and the system page is still served to them, because §7 gives a system no permissions. What
  // they get is the catalogue metadata with no page identity in it at all.
  const result = found(await getSystemDocumentation(f.asStranger, "order-hub"));
  expect(result.system.name).toBe("Order hub");
  expect(result.documented).toBe(0);
  expect(titlesOf(result)).toEqual([]);
  expect(result.groups.map((group) => group.docType)).toEqual(["ADR", "RUNBOOK", "RFC", "DOC"]);
});

/**
 * ## The other two exclusions
 */

test("a soft-deleted page disappears from a system's page, having been on it", async () => {
  const f = await fixture();
  const page = await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });

  // The non-vacuity half. Without it, a query that returned nothing at all would pass the
  // assertion below.
  expect(titlesOf(await getSystemDocumentation(f.asAisyah, "order-hub"))).toEqual([ALPHA_TITLE]);

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  const after = await getSystemDocumentation(f.asAisyah, "order-hub");
  expect(titlesOf(after)).toEqual([]);
  // The counts too: a group whose list is right and whose total counts a page nobody can open is
  // the divergence `index-read.ts` had to assert both halves for.
  expect(groupOf(after, "DOC").total).toBe(0);
});

/**
 * The third exclusion, and the state it excludes is not reachable from the product — which is
 * exactly why it is worth a test rather than a comment.
 *
 * `PageSystem` rows are written by `publishPage` and by nothing else, so a page with a facet has
 * been published, and no surface unsets `publishedVersionId`. The **schema** can still produce
 * it: `Page_publishedVersionId_fkey` is `ON DELETE SET NULL`, so deleting the version row nulls
 * the column while the facet rows survive. This constructs that row shape directly and says so,
 * rather than pretending it is a user journey.
 *
 * Deleting `publishedVersionId: { not: null }` from `pageScope` fails here, and what it would put
 * on the page is an unpublished title crossing a space boundary — the one thing this route must
 * not do.
 */
test("a page whose published version has gone is not listed", async () => {
  const f = await fixture();
  const page = await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });

  expect(titlesOf(await getSystemDocumentation(f.asAisyah, "order-hub"))).toEqual([ALPHA_TITLE]);

  // The `ON DELETE SET NULL` path, driven through the column it nulls.
  await db.page.update({ where: { id: page.id }, data: { publishedVersionId: null } });
  expect(await db.pageSystem.count({ where: { pageId: page.id } })).toBe(1);

  const after = await getSystemDocumentation(f.asAisyah, "order-hub");
  expect(titlesOf(after)).toEqual([]);
  expect(groupOf(after, "DOC").total).toBe(0);
});

/**
 * ## The groups, and what "open RFCs" resolved to
 */

test("open RFCs are listed, closed ones are counted and named rather than dropped", async () => {
  const f = await fixture();
  for (const status of OPEN_RFC_STATUSES) {
    await f.documented({
      spaceId: f.alpha.id,
      slug: `rfc-open-${status.toLowerCase()}`,
      title: `Open RFC ${status}`,
      docType: "RFC",
      status,
    });
  }
  for (const status of CLOSED_RFC_STATUSES) {
    await f.documented({
      spaceId: f.alpha.id,
      slug: `rfc-shut-${status.toLowerCase()}`,
      title: `Shut RFC ${status}`,
      docType: "RFC",
      status,
    });
  }

  const rfc = groupOf(await getSystemDocumentation(f.asAisyah, "order-hub"), "RFC");

  expect(rfc.rows.map((row) => row.status).sort()).toEqual([...OPEN_RFC_STATUSES].sort());
  expect(rfc.total).toBe(OPEN_RFC_STATUSES.length);
  // The number that makes the heading honest. A group labelled "Open RFCs" over a list that
  // silently hides the closed ones is the same class of lie this phase already refused twice, and
  // "some may be hidden" is not a checkable claim where a count is.
  expect(rfc.excluded).toBe(CLOSED_RFC_STATUSES.length);
  expect(rfc.excluded).toBeGreaterThan(0);
  for (const row of rfc.rows) expect(CLOSED_RFC_STATUSES).not.toContain(row.status);
});

test("a retired ADR stays listed — the asymmetry with RFCs is §7's and is deliberate", async () => {
  const f = await fixture();
  await f.documented({
    spaceId: f.alpha.id,
    slug: "adr-0042-mqtt-topic-naming",
    title: "MQTT topic naming",
    docType: "ADR",
    status: "SUPERSEDED",
  });
  await f.documented({
    spaceId: f.alpha.id,
    slug: "runbook-archived",
    title: "Retired runbook",
    docType: "RUNBOOK",
    status: "ARCHIVED",
  });

  const result = await getSystemDocumentation(f.asAisyah, "order-hub");
  // §6.4 keeps a retired decision readable as history, and a system's history is what this page
  // is for. Only the RFC group filters, because only §7 asked it to.
  expect(groupOf(result, "ADR").rows.map((row) => row.status)).toEqual(["SUPERSEDED"]);
  expect(groupOf(result, "ADR").excluded).toBe(0);
  expect(groupOf(result, "RUNBOOK").rows.map((row) => row.status)).toEqual(["ARCHIVED"]);
  expect(groupOf(result, "RUNBOOK").excluded).toBe(0);
});

test("a DOC that names a system is listed, in a group of its own", async () => {
  const f = await fixture();
  await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });

  // §7 names three groups and `DocType` has four values, and `resolveSystems` gates on none of
  // them — so a `DOC` can declare a system today. A page that could declare a facet and then
  // appear nowhere would be Phase 3's "empty facet" failure arriving by a third route.
  const result = await getSystemDocumentation(f.asAisyah, "order-hub");
  expect(groupOf(result, "DOC").rows.map((row) => row.title)).toEqual([ALPHA_TITLE]);
  expect(found(result).documented).toBe(1);
});

test("a page that names one system is not on another system's page", async () => {
  const f = await fixture();
  await f.documented({
    spaceId: f.alpha.id,
    slug: "alpha-doc",
    title: ALPHA_TITLE,
    systemIds: [f.hubCore.id],
  });

  // The join filter's own falsification: without `{ systems: { some: { systemId } } }` every
  // system's page would list every page in the corpus, which is the same enumeration by a
  // different route.
  expect(titlesOf(await getSystemDocumentation(f.asAisyah, "order-hub"))).toEqual([ALPHA_TITLE]);
  expect(titlesOf(await getSystemDocumentation(f.asAisyah, "store-ios"))).toEqual([]);
});

test("a system with no pages renders, with four empty groups and no repository", async () => {
  const f = await fixture();

  // The case the seeded corpus has three of — `store-ios` here stands in for a system whose
  // `repoUrl` is null, which `prisma/seed.ts` leaves that way for `backend`, `kiosk-bridge`
  // and `admin-web`. `e2e/systems.spec.ts` renders the real ones.
  const result = found(await getSystemDocumentation(f.asAisyah, "store-ios"));
  expect(result.documented).toBe(0);
  expect(result.system.repo).toEqual({ kind: "absent" });
  expect(result.groups.every((group) => group.rows.length === 0 && group.total === 0)).toBe(true);
});

/**
 * ## The catalogue
 */

test("the catalogue lists every system in key order, sunsetting ones included", async () => {
  const f = await fixture();
  await db.system.create({
    data: { key: "kiosk-bridge", name: "Kiosk bridge", kind: "SERVICE", isActive: false },
  });

  const systems = await listSystems();
  expect(systems.map((system) => system.key)).toEqual(["kiosk-bridge", "order-hub", "store-ios"]);

  // §7's "active or sunsetting" is metadata to render, not a filter: a system on its way out is
  // exactly the one whose decommissioning runbook a reader is looking for, and Task 2 already
  // decided a page may declare it.
  expect(systems.find((system) => system.key === "kiosk-bridge")?.isActive).toBe(false);
  expect(systems.find((system) => system.key === "order-hub")?.repo).toEqual({
    kind: "link",
    href: "https://git.acme-corp.dev/acme/hub/order-hub-gateway.git",
  });
  // Never the raw column: the summary carries a decision, so no surface can write
  // `<a href={system.repoUrl}>`.
  expect(systems.every((system) => !("repoUrl" in system))).toBe(true);
});

/**
 * The reader half of Task 1's credential finding, at the module boundary rather than only in
 * `repo-url.test.ts`: the point is that a row *stored* with a token produces a summary with no
 * token in it, so the two ends of the fix are joined somewhere.
 */
test("a repoUrl carrying a credential never reaches a caller", async () => {
  const f = await fixture();
  await db.system.create({
    data: {
      key: "leaky",
      name: "Leaky",
      kind: "SERVICE",
      repoUrl: "https://oauth2:glpat-SECRETVALUE123@gitlab.acme-partner.dev/acme/hub/order-hub-gateway.git",
    },
  });

  const summary = (await listSystems()).find((system) => system.key === "leaky");
  expect(summary?.repo).toEqual({ kind: "withheld", reason: "credentials" });
  expect(JSON.stringify(summary)).not.toContain("glpat-SECRETVALUE123");

  const page = found(await getSystemDocumentation(f.asRoot, "leaky"));
  expect(page.system.repo).toEqual({ kind: "withheld", reason: "credentials" });
  expect(JSON.stringify(page.system)).not.toContain("glpat-SECRETVALUE123");
});

test("an unknown key is not-found, and a mixed-case key resolves the way publish folds it", async () => {
  const f = await fixture();

  expect(await getSystemDocumentation(f.asAisyah, "no-such-system")).toEqual({
    ok: false,
    reason: "not-found",
  });
  // `foldSystemKey`, the same function Task 2 applies to an author's `systems:` value: one token
  // typed by people in two places, resolved by one rule.
  expect(found(await getSystemDocumentation(f.asAisyah, "ORDER-HUB")).system.key).toBe("order-hub");
});

/**
 * ## The publish round trip, so the read and the write are joined somewhere
 */
test("a real publish's declared system appears on that system's page", async () => {
  const f = await fixture();
  const page = await db.page.create({
    data: {
      spaceId: f.alpha.id,
      slug: "gantry",
      path: "gantry",
      title: "Gantry procedure",
      docType: "RUNBOOK",
      status: "DRAFT",
      createdById: f.aisyah.id,
    },
    select: { id: true },
  });
  const saved = await saveDraft(f.asAisyah, page.id, {
    title: "Gantry procedure",
    markdown: "---\nsystems: [order-hub]\n---\n\n# Gantry\n\nWeigh before departure.\n",
    seen: null,
  });
  if (!saved.ok) throw new Error(`saveDraft: ${JSON.stringify(saved)}`);
  const published = await publishPage(f.asAisyah, page.id);
  if (!published.ok) throw new Error(`publishPage: ${JSON.stringify(published)}`);

  const runbooks = groupOf(await getSystemDocumentation(f.asAisyah, "order-hub"), "RUNBOOK");
  expect(runbooks.rows.map((row) => row.title)).toEqual(["Gantry procedure"]);
  expect(runbooks.rows[0]?.spaceKey).toBe("alpha");
  expect(runbooks.rows[0]?.path).toBe("gantry");
});

/**
 * ## The audit — §8's super-admin trace, reusing the one rule rather than restating it
 *
 * `auditSpaceAccess` owns `needsAccessAudit` and the per-request dedupe. These tests are about
 * the **call pattern** this module chose: the default `"request"` scope, and one call per space a
 * listed row came from.
 */
test("a super admin's cross-space read writes one access row per space it listed", async () => {
  const f = await fixture();
  await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });
  await f.documented({ spaceId: f.beta.id, slug: "beta-doc", title: BETA_TITLE });
  await f.documented({ spaceId: f.handbook.id, slug: "hb-doc", title: "Handbook page" });

  await inOneRequest(() => getSystemDocumentation(f.asRoot, "order-hub"));

  const rows = await db.auditLog.findMany({
    where: { action: "space.access" },
    select: { spaceId: true },
  });
  // `handbook` is `ALL_STAFF`, so reading it is not a cross-boundary act and `needsAccessAudit`
  // says no — which is the rule living in `log.ts` rather than here, asserted so this call site
  // cannot quietly start deciding it for itself.
  expect(rows.map((row) => row.spaceId).sort()).toEqual([f.alpha.id, f.beta.id].sort());
});

test("a member reading a system page is not audited, and two requests are two rows", async () => {
  const f = await fixture();
  await f.documented({ spaceId: f.alpha.id, slug: "alpha-doc", title: ALPHA_TITLE });

  // The member is reading their own space: nothing to record.
  await inOneRequest(() => getSystemDocumentation(f.asAisyah, "order-hub"));
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(0);

  // The super admin, twice, in two requests — "how much did they read" is the question the table
  // answers, so the `"request"` scope is the right one for a render and two views are two rows.
  await inOneRequest(() => getSystemDocumentation(f.asRoot, "order-hub"));
  await inOneRequest(() => getSystemDocumentation(f.asRoot, "order-hub"));
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(2);
});

test("one request listing several pages from one space writes one row, not one per page", async () => {
  const f = await fixture();
  await f.documented({ spaceId: f.alpha.id, slug: "a1", title: "One" });
  await f.documented({ spaceId: f.alpha.id, slug: "a2", title: "Two", docType: "ADR" });
  await f.documented({ spaceId: f.alpha.id, slug: "a3", title: "Three", docType: "RUNBOOK" });

  await inOneRequest(() => getSystemDocumentation(f.asRoot, "order-hub"));

  // The `Map` keyed on space id is what collapses these before `auditSpaceAccess` is reached;
  // the per-request scope inside it would collapse them anyway, and both are cheap. Three
  // identical rows a millisecond apart is what this shape produces without either.
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(1);
});

test("the catalogue audits nothing — it reads no space and no page", async () => {
  await fixture();
  await inOneRequest(() => listSystems());
  expect(await db.auditLog.count()).toBe(0);
});
