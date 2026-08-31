import { db } from "../../setup/reset";
import { memoryStore } from "@/lib/blob/select";
import { driveKeyFor } from "@/lib/attachments/policy";
import type { SpaceRole, Viewer } from "@/lib/authz/types";

/**
 * Shared fixtures for the attachment suites.
 *
 * `resetDb` truncates Postgres but knows nothing about the memory store's Map, and
 * `select.ts` caches one store per process — so every fixture here starts by emptying it.
 * Without that, bytes from one test are visible to the next and an orphan assertion passes
 * or fails on file ordering.
 */
export function resetStore(): void {
  memoryStore().reset();
}

export type Cast = {
  spaceId: string;
  pageId: string;
  editor: Viewer;
  viewer: Viewer;
  admin: Viewer;
  stranger: Viewer;
  superAdmin: Viewer;
  editorMembershipId: string;
};

async function person(email: string, isSuperAdmin = false) {
  return db.user.create({ data: { email, name: email, isSuperAdmin }, select: { id: true } });
}

async function join(spaceId: string, email: string, role: SpaceRole) {
  const user = await person(email);
  const membership = await db.spaceMembership.create({
    data: { spaceId, userId: user.id, role },
    select: { id: true },
  });
  const viewer: Viewer = { id: user.id, isSuperAdmin: false, memberships: [{ spaceId, role }] };
  return { viewer, membershipId: membership.id };
}

/** A space, a page, and one viewer per role — published or not, as asked. */
export async function cast(opts: {
  visibility: "MEMBERS" | "ALL_STAFF";
  published: boolean;
}): Promise<Cast> {
  resetStore();

  const space = await db.space.create({
    data: { key: "attach", name: "Attachments", initials: "AT", visibility: opts.visibility },
    select: { id: true },
  });
  const author = await person("author@example.com");
  const page = await db.page.create({
    data: {
      spaceId: space.id, slug: "doc", path: "doc", title: "Doc",
      createdById: author.id, status: "DRAFT",
    },
    select: { id: true },
  });

  if (opts.published) {
    const version = await db.pageVersion.create({
      data: {
        pageId: page.id, title: "Doc", markdown: "# Doc",
        status: "CURRENT", authorId: author.id,
      },
      select: { id: true },
    });
    // `publishedVersionId` is what the read predicate's OR tests for. Setting it directly is
    // the point: this fixture is not exercising the publish path.
    await db.page.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
      select: { id: true },
    });
  }

  const editor = await join(space.id, "editor@example.com", "EDITOR");
  const viewer = await join(space.id, "viewer@example.com", "VIEWER");
  const admin = await join(space.id, "admin@example.com", "ADMIN");
  const stranger = await person("stranger@example.com");
  const root = await person("root@example.com", true);

  return {
    spaceId: space.id,
    pageId: page.id,
    editor: editor.viewer,
    viewer: viewer.viewer,
    admin: admin.viewer,
    editorMembershipId: editor.membershipId,
    stranger: { id: stranger.id, isSuperAdmin: false, memberships: [] },
    superAdmin: { id: root.id, isSuperAdmin: true, memberships: [] },
  };
}

type AttachmentOpts = {
  state?: "PENDING" | "COMMITTED";
  mimeType?: string;
  sizeBytes?: number;
  createdAt?: Date;
  deletedAt?: Date | null;
  withBytes?: boolean;
};

/** An attachment row on `pageId`, and optionally its bytes in the memory store. */
export async function attach(pageId: string, uploaderId: string, opts: AttachmentOpts = {}) {
  const {
    state = "COMMITTED", mimeType = "image/png", sizeBytes = 5,
    createdAt, deletedAt = null, withBytes = true,
  } = opts;

  const row = await db.attachment.create({
    data: {
      pageId, drivePath: "", filename: "shot.png", mimeType, sizeBytes,
      uploadedById: uploaderId, state, deletedAt,
      ...(createdAt ? { createdAt } : {}),
    },
    select: { id: true },
  });
  const drivePath = driveKeyFor(row.id, mimeType);
  await db.attachment.update({ where: { id: row.id }, data: { drivePath }, select: { id: true } });

  if (withBytes) await memoryStore().put(drivePath, new Uint8Array(sizeBytes));
  return { id: row.id, drivePath };
}

export async function drivePathOf(id: string): Promise<string> {
  const row = await db.attachment.findUniqueOrThrow({
    where: { id }, select: { drivePath: true },
  });
  return row.drivePath;
}
