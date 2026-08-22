import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { testLoginEnabled } from "@/lib/auth/test-login";
import { isAllowedSignIn, parseAllowedDomains } from "@/lib/users/gate";
import { upsertUserFromProfile } from "@/lib/users/upsert";

const allowedDomains = parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS);

const allowTestLogin = testLoginEnabled();

if (allowTestLogin) {
  console.warn(
    "[auth] ALLOW_TEST_LOGIN=1 — passwordless test login is REGISTERED. Never in a deployed environment.",
  );
}

const oidcProvider = {
  id: "company",
  name: "Company SSO",
  type: "oidc" as const,
  issuer: process.env.OIDC_ISSUER,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
};

const testProvider = Credentials({
  id: "test-login",
  name: "Test login",
  credentials: { email: { label: "Email", type: "email" } },
  async authorize(credentials) {
    if (!allowTestLogin) return null;
    const email = String(credentials?.email ?? "").trim().toLowerCase();
    if (!email) return null;
    const user = await db.user.findUnique({ where: { email } });
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Required outside recognised platforms. Auth.js otherwise defaults trustHost to
  // NODE_ENV !== "production", so this passes in dev and every auth endpoint returns 500
  // UntrustedHost in the Docker deployment — where next-auth swallows the 500 and returns
  // a null session, making the symptom "everyone is logged out" rather than an error.
  trustHost: true,
  session: {
    strategy: "jwt",
    // Auth.js re-encodes the token with a fresh expiry on every session read, so this is a
    // rolling window, not a fixed one. At the 30-day default, an account revoked upstream
    // keeps reading documentation for a month. Re-auth is a silent redirect through a live
    // IdP session, so eight hours costs the user nothing.
    maxAge: 60 * 60 * 8,
  },
  providers: allowTestLogin ? [oidcProvider, testProvider] : [oidcProvider],
  callbacks: {
    async jwt({ token, account }) {
      // `next-auth/jwt`'s module augmentation did not resolve under this project's
      // module resolution, so the provider claim is typed with an inline cast instead
      // of `declare module "next-auth/jwt" { interface JWT { prov?: string } }`.
      const t = token as { prov?: string };
      if (account) t.prov = account.provider;
      // A session minted by the passwordless test login must die the moment the flag
      // does. Without this claim a test-login token is byte-identical to an OIDC one:
      // turning the flag off cannot revoke it, and a shared AUTH_SECRET would let a
      // dev-minted super-admin token authenticate against production. Returning null
      // ends the session.
      if (t.prov === "test-login" && !allowTestLogin) return null;
      return t;
    },

    async signIn({ account, profile }) {
      // Task 14's test-login provider is already gated by ALLOW_TEST_LOGIN and resolves
      // only users the seed created, so the domain allowlist does not apply to it.
      if (account?.provider === "test-login") return true;

      // Ordering is load-bearing: returning false AFTER upserting would still create the
      // row, so the gate must come first.
      if (!isAllowedSignIn(
        { email: profile?.email, emailVerified: profile?.email_verified },
        allowedDomains,
      )) {
        return false;
      }

      await upsertUserFromProfile({
        email: profile!.email!,
        name: profile?.name ?? null,
        avatarUrl: typeof profile?.picture === "string" ? profile.picture : null,
      });
      return true;
    },
  },
});
