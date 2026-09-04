import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { commitUpload } from "@/lib/attachments/repo";
import { isInlineMime } from "@/lib/attachments/policy";

/**
 * The second half of the two-phase upload. The browser calls this once its direct upload to
 * Graph finishes, and the application verifies rather than believes.
 *
 * **The request body is ignored entirely.** There is deliberately no schema: everything this
 * endpoint needs is the id in the path and the viewer's session, and the one thing a client
 * might usefully send — Graph's item id — is the one thing that must not be trusted. Same
 * principle as bug-report context, which is derived from `routePath` and never accepted.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to attach a file." },
      { status: 401 },
    );
  }

  const { id } = await params;
  const result = await commitUpload(viewer, id);

  if (result.ok) {
    const { attachment } = result;
    const video = attachment.mimeType.startsWith("video/") && isInlineMime(attachment.mimeType);
    return NextResponse.json({
      id: attachment.id,
      // The `/video` suffix is what the render plugin matches to build a <video> element.
      // Images get the bare URL and stay ordinary Markdown images.
      url: `/api/attachments/${attachment.id}${video ? "/video" : ""}`,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      kind: video ? "video" : isInlineMime(attachment.mimeType) ? "image" : "file",
    });
  }

  switch (result.reason) {
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That upload could not be found." },
        { status: 404 },
      );
    case "not-uploaded":
      // 409, not 404: the row exists and the caller may edit it — the bytes never arrived.
      // A 404 would send a client that just uploaded looking for the wrong problem.
      return NextResponse.json(
        { error: "not-uploaded", message: "The file did not finish uploading. Try again." },
        { status: 409 },
      );
    case "size-mismatch":
      return NextResponse.json(
        { error: "size-mismatch", message: "The uploaded file did not match its declared size." },
        { status: 400 },
      );
    case "store-unavailable":
      return NextResponse.json(
        { error: "store-unavailable", message: "File storage is not responding. Try again." },
        { status: 503 },
      );
  }
}
