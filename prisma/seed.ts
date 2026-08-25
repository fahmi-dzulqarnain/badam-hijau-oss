import { PrismaClient, type DocStatus, type DocType } from "@prisma/client";
import { defaultPublishStatus, publishableStatuses } from "../src/lib/pages/transition";
import { article } from "../src/lib/lifecycle/relations";

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

    const page = await db.page.upsert({
      where: { spaceId_path: { spaceId: engineering.id, path } },
      update: {},
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

  console.log(
    `Seeded 2 spaces and ${ENGINEERING_PAGES.length + 1} pages.`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
