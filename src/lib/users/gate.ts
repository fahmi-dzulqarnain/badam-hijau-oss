export type SignInClaims = {
  email?: string | null;
  /** Deliberately `unknown`: this claim's runtime type varies by IdP. */
  emailVerified?: unknown;
};

export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an email claim counts as verified.
 *
 * The claim is not universally boolean — Auth.js types Okta's as `string` and Apple's as
 * `"true" | true` — so a strict `=== false` check would let the string "false" through as
 * if the claim were absent. That matters because the upsert matches on email: an issuer
 * willing to assert an unverified address hands over the matching row, including its
 * isSuperAdmin flag.
 *
 * An ABSENT claim is treated as verified. The OIDC spec makes it optional and several
 * legitimate providers never send it; rejecting absence would lock out real staff. Only an
 * explicit falsy assertion is a rejection.
 */
export function isEmailVerified(claim: unknown): boolean {
  if (claim === false) return false;
  if (typeof claim === "string" && claim.trim().toLowerCase() === "false") return false;
  return true;
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

  if (!isEmailVerified(claims.emailVerified)) return false;

  const domain = email.split("@")[1];
  if (!domain) return false;

  return allowedDomains.includes(domain);
}
