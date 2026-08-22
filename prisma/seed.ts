import { PrismaClient, type DocStatus, type DocType } from "@prisma/client";

const db = new PrismaClient();

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
    slug: "adr-0043-prisma-migrations",
    title: "Prisma migration policy",
    parent: "decisions",
    docType: "ADR",
    published: false,
  },
];

async function main() {
  const fahmi = await db.user.upsert({
    where: { email: "efcorporates@gmail.com" },
    update: {},
    create: {
      email: "efcorporates@gmail.com",
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

  for (const [index, seed] of ENGINEERING_PAGES.entries()) {
    const parentId = seed.parent ? idBySlug.get(seed.parent) : undefined;
    const path = seed.parent ? `${seed.parent}/${seed.slug}` : seed.slug;
    const status = seed.status ?? "CURRENT";

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

    if (seed.published === false) continue;

    const version = await db.pageVersion.create({
      data: {
        pageId: page.id,
        title: seed.title,
        markdown: seed.markdown ?? `Pages in **${seed.title}**.`,
        status,
        authorId: aisyah.id,
        message: "Seed",
      },
    });

    await db.page.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
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

  const welcomeVersion = await db.pageVersion.create({
    data: {
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
      message: "Seed",
    },
  });

  await db.page.update({
    where: { id: welcome.id },
    data: { publishedVersionId: welcomeVersion.id, publishedAt: new Date() },
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
