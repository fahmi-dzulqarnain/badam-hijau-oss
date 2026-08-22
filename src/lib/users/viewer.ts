import { db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/types";

export async function viewerForEmail(email: string): Promise<Viewer | null> {
  const user = await db.user.findUnique({
    // Lower-cased on both write (upsertUserFromProfile) and read, because the unique index
    // on email is a plain btree: providers vary in the case they return, and without this
    // the same person could resolve to two identities with different membership sets.
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      isSuperAdmin: true,
      memberships: { select: { spaceId: true, role: true } },
    },
  });
  if (!user) return null;

  return {
    id: user.id,
    isSuperAdmin: user.isSuperAdmin,
    memberships: user.memberships,
  };
}
