# Entra ID and SharePoint cutover

For whoever runs this migration. It is configuration, not code — `src/lib/auth/config.ts`
already registers a generic `oidc` provider with id `company`, driven by `OIDC_ISSUER`, and
Microsoft Graph is reached with an app-only (client-credentials) token, never a user token.
See spec §4 ([`docs/superpowers/specs/2026-08-26-attachments-sharepoint-entra-design.md`](../superpowers/specs/2026-08-26-attachments-sharepoint-entra-design.md))
for the reasoning; this document is the ordered steps and the failure modes at each one.

Do these in order. Steps 1–4 are the SSO cutover; steps 5–6 are the SharePoint grant. They
are independent of each other — you can do the SSO half on one day and the SharePoint half
on another — but within each half, order matters.

## 1. Register the application

In the Entra admin center (or Azure portal → Microsoft Entra ID → App registrations),
create a new registration for Badam. Single tenant — this is an internal tool, and a
multi-tenant registration would accept sign-ins from outside the company with no domain
check catching it until `ALLOWED_EMAIL_DOMAINS` (step 4).

Record the **Application (client) ID**, the **Directory (tenant) ID**, and generate a
client secret (or use a certificate, if the deployment prefers one). These three values
back `OIDC_CLIENT_ID`, the tenant segment of `OIDC_ISSUER`, and `OIDC_CLIENT_SECRET`.

The same registration is reused for the SharePoint app-only token in step 5 — one app
identity for both concerns, not two.

## 2. Add the redirect URI

The redirect URI is fixed by the provider id in `config.ts` (`company`) and is **not**
configurable independently of it:

```
${AUTH_URL}/api/auth/callback/company
```

Add it under the registration's "Web" platform, using the deployment's real `AUTH_URL`
(the canonical public origin — see `.env.example`). Add one entry per environment
(staging, production) if they have distinct origins; each is a separate exact-match URI,
not a pattern.

**Failure mode:** a mismatched or missing redirect URI fails at the IdP, before the
application ever runs — the browser is bounced back to Microsoft's own error page
("redirect_uri_mismatch" or similar), not to anything Badam renders. If sign-in fails
immediately after clicking through to Microsoft, this is the first thing to check.

## 3. Configure the optional `email` claim

**This is the step that determines whether anyone can sign in at all.** Entra ID v2.0
does not reliably emit an `email` claim — it emits `preferred_username` instead, and
`email` only rides along if the directory's `mail` attribute happens to be populated or
the optional claim is explicitly requested.

In the app registration, under Token configuration, add the optional claim `email` to the
**ID token**. (Depending on tenant configuration, Microsoft may prompt to also add the
`email` OpenID Connect scope permission — accept that if offered; without it the claim
can be configured but not actually delivered.)

**Failure mode:** `isAllowedSignIn` in `src/lib/users/gate.ts` returns `false` on a
missing email, and `src/lib/auth/config.ts`'s sign-in callback does `profile!.email!`
immediately after — so the symptom of skipping this step is not "some users can't sign
in", it is **"nobody can sign in"**, with every attempt failing the same way. There is no
per-user workaround; it is fixed at the app registration, not in code, and a
`preferred_username` fallback was deliberately rejected (see spec §4.2) — that claim is
documented by Microsoft as mutable and not an identifier, and `User.email` is the
`@unique` column identity is matched on. If sign-in fails for every account after the
redirect URI is confirmed working, check this claim first.

## 4. Set `ALLOWED_EMAIL_DOMAINS`

Set it to the comma-separated list of the tenant's **verified** domains — the ones that
should count as staff. This is the actual staff boundary: `OIDC_ISSUER` pins the tenant,
but a tenant can host guest accounts from other domains, and this allowlist is what
separates "signed in" from "staff" for `ALL_STAFF` spaces.

**Failure mode, in the direction that matters:** this fails closed. An empty value denies
everyone — loud, and easy to notice. Leaving a stale or wrong domain in the list, or
adding a domain that is not actually verified in this tenant, is the silent direction:
review it deliberately rather than copying it from another environment's `.env`.

## 5. Request `Sites.Selected`

On the same app registration, add the Microsoft Graph **application permission**
`Sites.Selected` and have a tenant admin grant it.

**Do not request `Files.ReadWrite.All` instead**, even though it is the more obviously-named
permission for "read and write files". `Files.ReadWrite.All` grants access to every drive
in the tenant, including every employee's personal OneDrive — a leaked `GRAPH_CLIENT_SECRET`
under that grant is a tenant-wide breach. `Sites.Selected` scopes access to only the sites
explicitly granted in step 6, so the blast radius of a leaked secret is the one document
library this deployment owns.

## 6. Grant the app access to the specific site

`Sites.Selected` grants nothing by itself — it only makes the per-site grant possible. A
tenant admin (this cannot be done as the application) makes one more call, to the specific
SharePoint site hosting the document library:

```
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
{ "roles": ["write"],
  "grantedToIdentities": [{ "application": { "id": "<client-id>", "displayName": "Badam" } }] }
```

`{site-id}` is the target SharePoint site's Graph id, and `<client-id>` is the Application
(client) ID from step 1. `"roles": ["write"]` — the app both mints upload sessions and
deletes drive items on the retention sweep, so read-only is not sufficient.

**Failure mode, and this is the one to expect, not to panic over:** after step 5 and
before this grant, every Graph call the application makes returns `403 Forbidden` — the
permission is consented at the tenant level but authorizes access to nothing yet. **This is
the expected intermediate state, not a misconfiguration.** If Graph calls 403 immediately
after granting `Sites.Selected`, the next step is checking whether this per-site grant was
made, not re-checking the permission itself.

Once granted, also record the target library's **drive id** (via Graph, or the "Get drive"
call against the site) for `GRAPH_DRIVE_ID` — the document library the application treats
as its one target.

## After both halves: the environment variables

```bash
# Tenant-specific, never `common` (see below).
OIDC_ISSUER="https://login.microsoftonline.com/<tenant-id>/v2.0"
OIDC_CLIENT_ID="<application (client) id>"
OIDC_CLIENT_SECRET="<client secret>"
ALLOWED_EMAIL_DOMAINS="<verified domain>,<verified domain>"

GRAPH_TENANT_ID="<directory (tenant) id>"
GRAPH_CLIENT_ID="<application (client) id>"     # same registration as OIDC_CLIENT_ID
GRAPH_CLIENT_SECRET="<client secret>"           # may be the same secret as OIDC_CLIENT_SECRET
GRAPH_DRIVE_ID="<drive id from step 6>"
BLOB_STORE="graph"
```

`OIDC_ISSUER` must be the **tenant-specific** issuer (`.../<tenant-id>/v2.0`), never
`common` — Auth.js validates the token's `iss` claim against the configured issuer, which
is what actually pins the tenant. Pointing at `common` would accept a token from any
tenant that happens to also be willing to authenticate this app registration.

`BLOB_STORE` has no default and the application refuses to boot on an unset or unrecognised
value; a real deployment must set it to `"graph"` explicitly. See `.env.example` for the
full reasoning and for `MAX_UPLOAD_BYTES` / `ATTACHMENT_RETENTION_DAYS`.

## What does not change, and the one thing that does

No application code changes for the SSO half — only the `OIDC_*` variables and
`ALLOWED_EMAIL_DOMAINS` above. `isEmailVerified` in `src/lib/users/gate.ts` already treats
an absent `email_verified` claim as verified (Entra sends none), so that code path already
covers this provider without modification.

The one accepted regression: Entra ID sends no `picture` claim, so `avatarUrl` is null for
every account created after the cutover. See the README's "Running it" section and spec
§4.3 — fetching a profile photo needs delegated Graph tokens, which is exactly the
per-user consent and refresh machinery this design avoids by authenticating to Graph as
the application, so it is not being fixed.
