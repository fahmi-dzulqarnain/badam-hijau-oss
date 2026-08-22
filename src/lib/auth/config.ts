import NextAuth from "next-auth";
import { upsertUserFromProfile } from "@/lib/users/upsert";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    {
      id: "company",
      name: "Company SSO",
      type: "oidc",
      issuer: process.env.OIDC_ISSUER,
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
    },
  ],
  callbacks: {
    async signIn({ profile }) {
      if (!profile?.email) return false;
      await upsertUserFromProfile({
        email: profile.email,
        name: profile.name ?? null,
        avatarUrl: typeof profile.picture === "string" ? profile.picture : null,
      });
      return true;
    },
  },
});
