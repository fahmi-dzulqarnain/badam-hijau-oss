export type SignInClaims = {
  email?: string | null;
  emailVerified?: boolean | null;
};

export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an OIDC profile may sign in at all. This is the staff boundary: spec §8 treats
 * "signed in" as "staff", so every ALL_STAFF space is readable by anyone this returns
 * true for.
 *
 * Fails closed on an empty allowlist. OIDC_ISSUER defaults to a multi-tenant issuer, so
 * without a domain check the boundary rests entirely on the IdP application being scoped
 * "internal" — a setting this codebase can neither see nor test. "Nobody can sign in" is
 * a loud failure; "everybody can" is a silent one.
 */
export function isAllowedSignIn(claims: SignInClaims, allowedDomains: string[]): boolean {
  const email = claims.email?.trim().toLowerCase();
  if (!email) return false;

  // An unverified email claim is an assertion, not an identity. This matters more than it
  // looks: the upsert matches on email, so an issuer willing to mint
  // email_verified:false for an existing address hands over that account, including its
  // isSuperAdmin flag. Providers that omit the claim entirely are accepted — only an
  // explicit false is a rejection.
  if (claims.emailVerified === false) return false;

  const domain = email.split("@")[1];
  if (!domain) return false;

  return allowedDomains.includes(domain);
}
