import { db } from "@/lib/db";

export type OidcProfile = {
  email: string;
  name: string | null;
  avatarUrl?: string | null;
};

export async function upsertUserFromProfile(profile: OidcProfile) {
  const email = profile.email.toLowerCase();
  const providedName = profile.name?.trim();
  const fallbackName = email.split("@")[0] ?? email;

  return db.user.upsert({
    where: { email },
    // isSuperAdmin is deliberately absent: it is granted in our system, not theirs. Note
    // this stops the flag being SET, but not an existing privileged row being adopted —
    // that is what the email_verified check in the sign-in gate is for.
    //
    // Both fields use `undefined` to mean "leave alone", so a provider that stops sending
    // a name or a picture preserves what we already have instead of overwriting it.
    update: { name: providedName || undefined, avatarUrl: profile.avatarUrl ?? undefined },
    create: { email, name: providedName || fallbackName, avatarUrl: profile.avatarUrl ?? null },
  });
}
