import { NextResponse } from "next/server";
import { memoryStore, memoryStoreEnabled } from "@/lib/blob/select";

/**
 * Where the memory store's upload sessions point. **Never live outside a memory-store
 * process**, and treated with the same suspicion as the passwordless test login: it is an
 * unauthenticated write.
 *
 * It is not a hole in the deployed system because it cannot exist there — `BLOB_STORE=graph`
 * makes every request here a 404, byte-identical to a route that was never registered. The
 * `dev-upload-route` integration test pins that, because "it is only for development" is a
 * claim, not a mechanism.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!memoryStoreEnabled()) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const { key } = await params;
  // Traversal is refused rather than normalised, so both stores hold the same shape of key.
  if (key.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return NextResponse.json({ error: "invalid-key" }, { status: 400 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  await memoryStore().put(key.join("/"), bytes);
  return new NextResponse(null, { status: 201 });
}
