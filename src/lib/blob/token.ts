export type GraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

/** Refetch this far before real expiry, so a token is never used inside the rejection window. */
const SKEW_MS = 60_000;

/**
 * An app-only Graph token, cached in memory.
 *
 * App-wide by nature: client-credentials tokens carry no user, so one token serves every
 * request in the process. That is the whole reason this design needs no `Account` table and no
 * refresh machinery — the alternative, delegated tokens, would need both.
 *
 * The in-flight promise is shared rather than the value alone, because a page holding twelve
 * images would otherwise cold-start twelve identical token requests against an endpoint that
 * rate-limits. A REJECTED promise is cleared rather than cached: leaving it in place turns one
 * transient 401 into a permanently broken feature until the process restarts.
 */
export class GraphToken {
  #inFlight: Promise<string> | null = null;
  #value: string | null = null;
  #expiresAt = 0;

  constructor(
    private readonly credentials: GraphCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async value(): Promise<string> {
    if (this.#value && Date.now() < this.#expiresAt - SKEW_MS) return this.#value;
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#request().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #request(): Promise<string> {
    const { tenantId, clientId, clientSecret } = this.credentials;
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );

    // The status only. A body from the token endpoint can echo request parameters, and this
    // message reaches logs.
    if (!response.ok) {
      throw new Error(`Graph token request failed with ${response.status}`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || !body.expires_in) {
      throw new Error("Graph token response carried no access_token");
    }

    this.#value = body.access_token;
    this.#expiresAt = Date.now() + body.expires_in * 1000;
    return this.#value;
  }
}
