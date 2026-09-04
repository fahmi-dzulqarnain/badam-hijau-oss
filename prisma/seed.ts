import {
  PrismaClient,
  type DocStatus,
  type DocType,
  type SystemKind,
} from "@prisma/client";
import { defaultPublishStatus, publishableStatuses } from "../src/lib/pages/transition";
import { article } from "../src/lib/lifecycle/relations";
import { reindexSearchText } from "../src/lib/search/reindex";

const db = new PrismaClient();

// Fixed, not `new Date()`. Re-running the seed must leave the database in the same state it
// was already in, and a moving timestamp reorders "Recently published" on every run.
const PUBLISHED_EPOCH = new Date("2026-08-20T09:00:00Z");
const publishedAtFor = (index: number) =>
  new Date(PUBLISHED_EPOCH.getTime() + index * 60_000);

/**
 * Publishes a version only when the content actually differs from what is already
 * published. The naive form — always `pageVersion.create` — is not idempotent: every seed
 * run manufactured a fresh version for all six pages, so the history filled with identical
 * "Seed" entries and `publishedAt` jumped forward each time.
 */
async function publishSeedVersion(opts: {
  pageId: string;
  title: string;
  markdown: string;
  status: DocStatus;
  authorId: string;
  publishedAt: Date;
}): Promise<void> {
  const page = await db.page.findUniqueOrThrow({
    where: { id: opts.pageId },
    select: {
      publishedVersion: { select: { title: true, markdown: true, status: true } },
    },
  });

  const current = page.publishedVersion;
  if (
    current &&
    current.title === opts.title &&
    current.markdown === opts.markdown &&
    current.status === opts.status
  ) {
    return;
  }

  const version = await db.pageVersion.create({
    data: {
      pageId: opts.pageId,
      title: opts.title,
      markdown: opts.markdown,
      status: opts.status,
      authorId: opts.authorId,
      message: "Seed",
    },
  });

  await db.page.update({
    where: { id: opts.pageId },
    data: { publishedVersionId: version.id, publishedAt: opts.publishedAt },
  });
}

type SeedSystem = {
  key: string;
  name: string;
  kind: SystemKind;
  ownerTeam: string;
  description: string;
  repoUrl?: string;
  isActive?: boolean;
};

/**
 * The seven systems §7 names, in §7's order.
 *
 * **Every field is drawn from something checkable rather than invented**, because a service
 * catalogue full of plausible fiction is worse than an empty one: the whole value of §7's
 * "lightweight service catalogue" is that a reader can act on what it says. Where this machine
 * holds no fact, the column is `null` and Task 5 is where an admin supplies it.
 *
 * `kind`, where the enum forced a choice — the full argument is on `enum SystemKind` in
 * `prisma/schema.prisma`:
 *
 * - `store-ios` and `display-ios` are both iPad apps on the same hardware, so the enum's
 *   `MOBILE_APP`/`DEVICE_APP` split cannot be about the device. It is about who operates it: a
 *   cashier drives `store-ios`; `display-ios` faces the customer from a fixed second screen with no
 *   operator at all.
 * - `order-hub` and `pricing-engine` are `LIBRARY` because both are npm packages published to
 *   the `@acme-hub` GitLab registry and consumed, not deployed.
 * - `admin-web` is a `SERVICE` under protest. §5.2's enum has no web-app kind and this phase does
 *   not widen a normative enum.
 *
 * `repoUrl` is the remote of a real checkout on the machine this seed was written on, with any
 * credentials removed — see `System.repoUrl`'s comment, because the removal is the point: the
 * real `git remote -v` output here embeds a live GitLab token, and that string is what an admin
 * would paste into Task 5's form.
 *
 * `ownerTeam` values are the names this repository and this estate already use. `Kiosk` is
 * literally in the seeded corpus: the topic registry page below assigns `acme/+/kiosk` to it.
 *
 * **`kiosk-bridge` is seeded `isActive: false`, and that is derived rather than decorative.**
 * The seeded ADR `adr-0042-mqtt-topic-naming` says, in its own Consequences section, "Every
 * publisher must be redeployed before the bridge is removed" — so this corpus already describes
 * the bridge as on its way out. It also means §7's "active or sunsetting" has both branches
 * present in the fixture, which matters for the reason this project keeps relearning: a guard
 * that asserts a class over a fixed corpus is testing the corpus, and Task 3 renders both states.
 */
const SEED_SYSTEMS: SeedSystem[] = [
  {
    key: "store-ios",
    name: "Acme Store (iOS)",
    kind: "MOBILE_APP",
    ownerTeam: "Mobile",
    description:
      "The fuel-station point-of-sale iPad app a cashier operates. SwiftUI with MVVM and " +
      "Stinsen coordinators, Realm for local state, MQTT to the outlet's hub.",
    repoUrl: "https://gitlab.acme-partner.dev/acme/mobile/ios/store-pos.git",
  },
  {
    key: "display-ios",
    name: "Acme customer display",
    kind: "DEVICE_APP",
    ownerTeam: "Mobile",
    description:
      "The customer-facing display: a second iPad showing the live cart, the receipt and the " +
      "cashier's state, fed by store-ios over a TCP socket. Nobody operates it.",
    repoUrl: "https://gitlab.acme-partner.dev/acme/mobile/ios/acme-display.git",
  },
  {
    key: "order-hub",
    name: "Order hub",
    kind: "LIBRARY",
    ownerTeam: "Hub",
    // The checkout this remote belongs to describes itself, in its own package manifest, as
    // "ACME ORDER HUB", and its module tree is the one the hub's own documentation describes —
    // order, fuel, payment, loyalty, subsidy, day-operation, kiosk. Stated that way rather
    // than asserted flatly, because the repository is *named* order-hub-gateway and a catalogue entry should
    // say what can be checked.
    repoUrl: "https://git.acme-corp.dev/acme/hub/order-hub-gateway.git",
    description:
      "The POS engine each outlet's hub device runs: orders, fuel, payments, loyalty, receipts, " +
      "cloud sync and kiosk control. NestJS, Mongoose, CQRS, published as an npm package " +
      "rather than deployed.",
  },
  {
    key: "pricing-engine",
    name: "Pricing engine",
    kind: "LIBRARY",
    ownerTeam: "Hub",
    description:
      "Charges, taxes, promotions and external discounts, on big.js so no total is computed in " +
      "native floating point. Consumed by order-hub and bundled for the browser.",
    repoUrl: "https://gitlab.acme-partner.dev/acme/hub/packages/pricing-engine.git",
  },
  {
    key: "backend",
    name: "Acme Cloud backend",
    kind: "SERVICE",
    ownerTeam: "Cloud",
    // No repoUrl: there is no checkout of it on this machine, and a wrong link in a service
    // catalogue is worse than no link. Task 5 is the surface that fills this in.
    description:
      "The cloud side, reached through the Acme SDK. Products, staff and prices sync down to " +
      "each hub; orders and day-operation state sync up.",
  },
  {
    key: "kiosk-bridge",
    name: "Kiosk bridge",
    kind: "SERVICE",
    ownerTeam: "Kiosk",
    description:
      "Translates the kiosk controller's own protocol into the acme/{outlet}/kiosk/… " +
      "MQTT topics adr-0042 governs. Being retired: its publishers are moving onto the " +
      "namespace directly.",
    isActive: false,
  },
  {
    key: "admin-web",
    name: "Admin console",
    kind: "SERVICE",
    ownerTeam: "Cloud",
    description:
      "The browser console for outlet, pricing and staff administration. A SERVICE only because " +
      "§5.2's SystemKind has no web-app value.",
  },
];

type SeedPage = {
  slug: string;
  title: string;
  parent?: string;
  docType?: DocType;
  status?: DocStatus;
  markdown?: string;
  published?: boolean;
};

const ENGINEERING_PAGES: SeedPage[] = [
  { slug: "architecture", title: "Architecture" },
  {
    slug: "mqtt-contracts",
    title: "MQTT contracts",
    parent: "architecture",
    markdown: [
      "The normative list of kiosk topics.",
      "",
      "## Namespace",
      "",
      "Every message uses `acme/{outlet}/{domain}/{entity}/{event}`.",
      "",
      "| Segment | Owner |",
      "| --- | --- |",
      "| `outlet` | Provisioning |",
      "| `domain` | Architecture |",
      "",
      "## Subscribing",
      "",
      "```ts",
      "await client.subscribe(`acme/${outlet}/kiosk/+/#`);",
      "```",
      "",
      "## Diagram",
      "",
      "```mermaid",
      "C4Context",
      '  Person(cashier, "Cashier")',
      "```",
      "",
    ].join("\n"),
  },
  { slug: "decisions", title: "Decisions" },
  {
    slug: "adr-0042-mqtt-topic-naming",
    title: "MQTT topic naming for kiosk events",
    parent: "decisions",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: [
      "## Context",
      "",
      "Kiosk topics grew organically across three outlet generations.",
      "",
      "## Decision",
      "",
      "Adopt one hierarchical namespace for every kiosk message.",
      "",
      "## Consequences",
      "",
      "- Provisioning a new outlet needs no code change.",
      "- Every publisher must be redeployed before the bridge is removed.",
      "",
    ].join("\n"),
  },
  {
    // Three levels deep, deliberately. The navigation rail renders recursively, and
    // nothing else in the seed goes past two levels — so without this page the recursion
    // is unexercised and a regression to a fixed two-level render would leave this page
    // invisible in the rail while still reachable by URL, with nothing failing.
    slug: "topic-registry",
    title: "Topic registry",
    parent: "mqtt-contracts",
    markdown: [
      "Who owns which topic prefix.",
      "",
      "## Registry",
      "",
      "| Prefix | Owner |",
      "| --- | --- |",
      "| `acme/+/kiosk` | Kiosk |",
      "| `acme/+/loyalty` | Loyalty |",
      "",
    ].join("\n"),
  },
  {
    slug: "adr-0043-prisma-migrations",
    title: "Prisma migration policy",
    parent: "decisions",
    docType: "ADR",
    published: false,
  },
];

async function main() {
  const fahmi = await db.user.upsert({
    where: { email: "admin@example.com" },
    update: {},
    create: {
      email: "admin@example.com",
      name: "Fahmi D.",
      isSuperAdmin: true,
    },
  });

  const aisyah = await db.user.upsert({
    where: { email: "aisyah@example.com" },
    update: {},
    create: { email: "aisyah@example.com", name: "Aisyah R." },
  });

  // Signs in successfully but is a member of nothing. Proves 404-not-403 in the browser.
  await db.user.upsert({
    where: { email: "stranger@example.com" },
    update: {},
    create: { email: "stranger@example.com", name: "Sam Stranger" },
  });

  const engineering = await db.space.upsert({
    where: { key: "engineering" },
    update: {},
    create: {
      key: "engineering",
      name: "Engineering",
      initials: "EN",
      visibility: "MEMBERS",
      description:
        "How the POS platform is built, decided, and recovered when it breaks.",
      memberships: {
        create: [
          { userId: aisyah.id, role: "EDITOR" },
          { userId: fahmi.id, role: "ADMIN" },
        ],
      },
    },
  });

  const handbook = await db.space.upsert({
    where: { key: "handbook" },
    update: {},
    create: {
      key: "handbook",
      name: "Company handbook",
      initials: "CH",
      visibility: "ALL_STAFF",
      description: "Policies and process everyone can read.",
    },
  });

  // Systems before pages, and not only for tidiness: Task 2 resolves a page's `systems:`
  // frontmatter against this catalogue inside the publish transaction, so a seed that ever
  // declares systems on a seeded page needs the catalogue to exist by the time the page loop
  // runs.
  //
  // ## `update: {}`, and this time the reason is that there is nothing to repair
  //
  // Phase 2 made this seed idempotent and Phase 3 had to add a *narrow repair* on top, because
  // `upsert` with `update: {}` does not fix an existing row whose value has become invalid — the
  // seeded ADR was sitting at a `DocStatus` its own doc type's vocabulary could not reach, and
  // `npm run smoke` re-seeds `badam` without dropping it, so a create-only fix would have helped
  // a fresh database and left a stale one stale forever.
  //
  // The property that made that possible is worth naming, because it is what decides the answer
  // here: **`DocStatus` is a column type wider than the rule the product enforces.** The
  // vocabulary is per doc type and lives in application code, so the column could legitimately
  // hold a value the product cannot produce. Enumerate this table against that test and nothing
  // qualifies:
  //
  // - `key` is the `where`, so it cannot drift out from under the upsert — and its narrowing is
  //   a CHECK constraint in the migration, so an illegal one is refused by Postgres rather than
  //   repaired by this file afterwards.
  // - `kind` is a Postgres enum with **no** second-order rule: every `SystemKind` is legal for
  //   every system, unlike a `DocStatus`, which is legal only for some doc types.
  // - `isActive` is a boolean.
  // - `name`, `description`, `ownerTeam` and `repoUrl` are free text that nothing validates, so
  //   an edit to any of them is an admin's edit (Task 5 exists to make them) and not a defect.
  //
  // So a repair clause here would be a guard that cannot fire — which this project has explicitly
  // declined once before, when Phase 3 Task 13 refused to add a `PageRelation` clause to the
  // smoke sweep for the same reason. `update: {}` it is, matching `Space` and `User` above.
  //
  // **The cost, stated rather than left to be discovered by Task 9.** `update: {}` means a later
  // task that changes a seeded system's `name`, `kind` or `repoUrl` changes it only on a *fresh*
  // database; `badam` keeps the old value, exactly as it keeps old `Page` titles and old `Space`
  // names today. So an assertion in `scripts/smoke.sh` or the Playwright suite should bind to a
  // system's **key**, which is the one column this upsert can never leave stale. A task that
  // really must move a seeded value owes a narrow repair, and the paragraph above is the test for
  // whether it is entitled to one.
  //
  // What this loop does *not* do is delete a system the catalogue no longer lists. Task 5 makes
  // deletion an admin action with a reference count behind it, and a seed that pruned rows would
  // be that action with no operator and no count — and `PageSystem.systemId` is `Restrict`, so it
  // would fail noisily the first time an author had named one.
  for (const system of SEED_SYSTEMS) {
    await db.system.upsert({
      where: { key: system.key },
      update: {},
      create: {
        key: system.key,
        name: system.name,
        kind: system.kind,
        ownerTeam: system.ownerTeam,
        description: system.description,
        repoUrl: system.repoUrl ?? null,
        isActive: system.isActive ?? true,
      },
    });
  }

  const idBySlug = new Map<string, string>();
  // Paths are built from the parent's PATH, not its slug. Deriving from the slug only
  // works two levels deep: a third level would get `mqtt-contracts/topic-registry`
  // instead of `architecture/mqtt-contracts/topic-registry`, which is silently wrong and
  // breaks every lookup for that page.
  const pathBySlug = new Map<string, string>();

  for (const [index, seed] of ENGINEERING_PAGES.entries()) {
    const parentId = seed.parent ? idBySlug.get(seed.parent) : undefined;
    const parentPath = seed.parent ? pathBySlug.get(seed.parent) : undefined;
    const path = parentPath ? `${parentPath}/${seed.slug}` : seed.slug;
    // Not `?? "CURRENT"`. That wrote `CURRENT` regardless of doc type or whether the page was
    // published, which left the seeded ADR `adr-0043` — an unpublished one — sitting at a status
    // `PUBLISHABLE_INTO.ADR` can reach from nowhere and move to nowhere. Phase 3's ADR index
    // found it on its first render.
    //
    // An unpublished page is `DRAFT`, which is what `createPage` writes. A published one takes
    // its doc type's first-publish status, which is `CURRENT` for DOC and RUNBOOK — so the other
    // six seeded pages are unchanged — and `PROPOSED` for an ADR.
    const status: DocStatus =
      seed.status ??
      (seed.published === false ? "DRAFT" : defaultPublishStatus(seed.docType ?? "DOC", "DRAFT"));

    // The seed is a fixture every test and the smoke script build on, so an illegal status here
    // is a defect that presents itself as a product bug somewhere else entirely. `DRAFT` is
    // legal for any type as an origin; anything else has to be reachable in that type's own
    // vocabulary.
    if (
      status !== "DRAFT" &&
      !publishableStatuses(seed.docType ?? "DOC").includes(status)
    ) {
      throw new Error(
        `Seed page ${path} is ${article(seed.docType ?? "DOC")} at ${status}, which that doc ` +
          `type's ` +
          `vocabulary cannot reach. Legal: DRAFT, ` +
          `${publishableStatuses(seed.docType ?? "DOC").join(", ")}.`,
      );
    }

    // `update: {}` everywhere else, deliberately — re-running the seed must not clobber an
    // editor's work. The one exception is a status this doc type's vocabulary cannot hold: that
    // is not an edit, it is data the product cannot produce, and it was reachable because this
    // very line used to write `CURRENT` to everything. Without the repair the fix only helps a
    // *fresh* database — `npm run smoke` re-seeds `badam` without dropping it, so a stale row
    // would keep an illegal status forever and the ADR index would keep reporting it.
    //
    // Narrow on purpose: a legal status is left alone even when it differs from the derived one,
    // so an editor who published an ADR to `ACCEPTED` keeps it.
    const existing = await db.page.findUnique({
      where: { spaceId_path: { spaceId: engineering.id, path } },
      select: { status: true, docType: true },
    });
    const repair =
      existing &&
      existing.status !== "DRAFT" &&
      !publishableStatuses(existing.docType).includes(existing.status);
    if (repair) {
      console.warn(
        `[seed] repairing ${path}: ${existing.docType} at ${existing.status} is not in that ` +
          `doc type's vocabulary, setting ${status}`,
      );
    }

    const page = await db.page.upsert({
      where: { spaceId_path: { spaceId: engineering.id, path } },
      update: repair ? { status } : {},
      create: {
        spaceId: engineering.id,
        parentId: parentId ?? null,
        slug: seed.slug,
        path,
        title: seed.title,
        docType: seed.docType ?? "DOC",
        status,
        position: index,
        ownerId: aisyah.id,
        createdById: aisyah.id,
        reviewedAt: new Date("2026-08-18T00:00:00Z"),
      },
    });
    idBySlug.set(seed.slug, page.id);
    pathBySlug.set(seed.slug, path);

    if (seed.published === false) continue;

    await publishSeedVersion({
      pageId: page.id,
      title: seed.title,
      markdown: seed.markdown ?? `Pages in **${seed.title}**.`,
      status,
      authorId: aisyah.id,
      publishedAt: publishedAtFor(index),
    });
  }

  // The handbook needs at least one readable page, or a viewer who belongs to nothing
  // signs in and sees an empty shell — which demonstrates the permission model badly and
  // leaves the ALL_STAFF read path with nothing to exercise in the browser or in E2E.
  const welcome = await db.page.upsert({
    where: { spaceId_path: { spaceId: handbook.id, path: "welcome" } },
    update: {},
    create: {
      spaceId: handbook.id,
      slug: "welcome",
      path: "welcome",
      title: "Welcome",
      position: 0,
      ownerId: fahmi.id,
      createdById: fahmi.id,
      reviewedAt: new Date("2026-08-18T00:00:00Z"),
      status: "CURRENT",
    },
  });

  await publishSeedVersion({
    pageId: welcome.id,
    title: "Welcome",
    markdown: [
      "Everything in this space is readable by anyone who can sign in.",
      "",
      "## Finding things",
      "",
      "Spaces group documentation by the team that owns it. If a space is not listed,",
      "you are not a member of it — ask its owner for access.",
      "",
    ].join("\n"),
    status: "CURRENT",
    authorId: fahmi.id,
    publishedAt: publishedAtFor(ENGINEERING_PAGES.length),
  });

  // The search index's text half, for every version this run wrote and every version an
  // earlier run wrote before the columns existed.
  //
  // Here rather than inside `publishSeedVersion` for the same reason the status repair above
  // exists: `npm run smoke` and the E2E suite re-seed `badam` without dropping it, so a fix
  // applied only on `create` helps a fresh database and leaves a stale one stale forever. The
  // six versions this seed wrote before Phase 4 carry the `''` default, and `''` on a published
  // version is a page searchable by title with a body nobody can find.
  //
  // Idempotent by comparison, not by flag: it re-strips every version and writes only the ones
  // that disagree, so a second seed rewrites nothing and fires no trigger — which is what keeps
  // re-seeding free of churn, the property this file already had to be taught once.
  const reindexed = await reindexSearchText(db);
  if (reindexed.rewritten > 0) {
    console.log(
      `[seed] reindexed ${reindexed.rewritten} of ${reindexed.scanned} versions' search text.`,
    );
  }

  console.log(
    `Seeded 2 spaces, ${ENGINEERING_PAGES.length + 1} pages and ` +
      `${SEED_SYSTEMS.length} systems.`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
