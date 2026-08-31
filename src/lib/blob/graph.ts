import { GraphToken, type GraphCredentials } from "./token";
import type { BlobBody, BlobRange, BlobStat, BlobStore, UploadSession } from "./store";

const GRAPH = "https://graph.microsoft.com/v1.0";

export type GraphConfig = GraphCredentials & { driveId: string };

/** Just enough of `GraphToken` to substitute in tests. */
type TokenSource = { value(): Promise<string> };

function configFromEnv(): GraphConfig {
  const required = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_DRIVE_ID"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`BLOB_STORE="graph" needs ${missing.join(", ")}`);
  }
  return {
    tenantId: process.env.GRAPH_TENANT_ID!,
    clientId: process.env.GRAPH_CLIENT_ID!,
    clientSecret: process.env.GRAPH_CLIENT_SECRET!,
    driveId: process.env.GRAPH_DRIVE_ID!,
  };
}

/**
 * A SharePoint document library, reached as the application.
 *
 * The registration holds `Sites.Selected` plus a per-site grant, NOT `Files.ReadWrite.All` —
 * see `docs/ops/entra-id-and-sharepoint.md`. That is the difference between a leaked client
 * secret exposing one library and it exposing every drive in the tenant.
 *
 * Note the error discipline: a missing item is `null` and everything else THROWS. The read
 * route turns the first into 404 and the second into 502, and collapsing them would make a
 * Graph outage look like every attachment having been deleted.
 */
export class GraphBlobStore implements BlobStore {
  readonly #config: GraphConfig;
  readonly #token: TokenSource;
  readonly #fetch: typeof fetch;

  constructor(config?: GraphConfig, token?: TokenSource, fetchImpl: typeof fetch = fetch) {
    this.#config = config ?? configFromEnv();
    this.#token = token ?? new GraphToken(this.#config, fetchImpl);
    this.#fetch = fetchImpl;
  }

  /** `/drives/{id}/root:/{key}:` — the path-addressed form, so no item id is needed. */
  #item(key: string): string {
    return `${GRAPH}/drives/${this.#config.driveId}/root:/${key}:`;
  }

  async #headers(extra: HeadersInit = {}): Promise<Headers> {
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${await this.#token.value()}`);
    return headers;
  }

  async beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession> {
    const response = await this.#fetch(`${this.#item(key)}/createUploadSession`, {
      method: "POST",
      headers: await this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "fail",
          name: key.split("/").at(-1),
        },
        // Advisory only. The commit endpoint reads the real size back and refuses a mismatch,
        // because a client that declares one size can send another.
        deferCommit: false,
        fileSize: sizeBytes,
        mimeType,
      }),
    });
    if (!response.ok) {
      throw new Error(`createUploadSession failed with ${response.status}`);
    }
    const body = (await response.json()) as { uploadUrl: string; expirationDateTime: string };
    return { uploadUrl: body.uploadUrl, expiresAt: new Date(body.expirationDateTime) };
  }

  async stat(key: string): Promise<BlobStat | null> {
    const response = await this.#fetch(`${this.#item(key)}?$select=size,eTag`, {
      headers: await this.#headers(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`stat failed with ${response.status}`);
    const body = (await response.json()) as { size: number; eTag?: string };
    return { sizeBytes: body.size, eTag: body.eTag ?? null };
  }

  async fetch(key: string, range?: BlobRange): Promise<BlobBody | null> {
    const headers = await this.#headers();
    if (range) headers.set("range", `bytes=${range.start}-${range.end}`);

    const response = await this.#fetch(`${this.#item(key)}/content`, { headers, redirect: "follow" });
    if (response.status === 404) return null;
    if (!response.ok && response.status !== 206) {
      throw new Error(`content fetch failed with ${response.status}`);
    }

    const sizeBytes = Number(response.headers.get("content-length") ?? 0);
    return {
      stream: response.body!,
      sizeBytes,
      // A 206 reports the SLICE in Content-Length; the object's real length is only in
      // Content-Range. The proxy needs the total to build its own header.
      totalBytes: totalFromContentRange(response.headers.get("content-range")) ?? sizeBytes,
      eTag: response.headers.get("etag"),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.#fetch(this.#item(key), {
      method: "DELETE",
      headers: await this.#headers(),
    });
    // Already gone is the desired state, so 404 is success. Delete must be idempotent: the
    // sweep re-runs, and a second pass must not fail on work the first one finished.
    if (!response.ok && response.status !== 404 && response.status !== 204) {
      throw new Error(`delete failed with ${response.status}`);
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string }> {
    // `children` is one folder deep, which is all the layout has: keys are `{shard}/{id}{ext}`.
    let url: string | null =
      `${GRAPH}/drives/${this.#config.driveId}/root:/${prefix.replace(/\/$/, "")}:/children?$select=name`;
    while (url) {
      const response: Response = await this.#fetch(url, { headers: await this.#headers() });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`list failed with ${response.status}`);
      const body = (await response.json()) as {
        value: { name: string }[];
        "@odata.nextLink"?: string;
      };
      for (const child of body.value) yield { key: `${prefix.replace(/\/$/, "")}/${child.name}` };
      url = body["@odata.nextLink"] ?? null;
    }
  }
}

function totalFromContentRange(header: string | null): number | null {
  const match = header?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}
