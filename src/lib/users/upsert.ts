import { db } from "@/lib/db";

export type OidcProfile = {
  email: string;
  name: string | null;
  avatarUrl?: string | null;
};

export async function upsertUserFromProfile(profile: OidcProfile) {
  const email = profile.email.toLowerCase();
  const name = profile.name?.trim() || (email.split("@")[0] ?? email);

  return db.user.upsert({
    where: { email },
    // isSuperAdmin is deliberately absent: it is granted in our system, not theirs.
    update: { name, avatarUrl: profile.avatarUrl ?? undefined },
    create: { email, name, avatarUrl: profile.avatarUrl ?? null },
  });
}
