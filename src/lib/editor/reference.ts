import type { UploadedAttachment } from "./upload";

/**
 * The Markdown an upload inserts.
 *
 * The escaping is the same class of problem as `Content-Disposition`: a filename is user input
 * being spliced into a structured syntax. `a](x).png` unescaped rewrites the document's link
 * structure from inside the label.
 */
export function referenceFor(attachment: UploadedAttachment): string {
  const label = attachment.filename
    // No escape exists for a newline inside link text — it simply ends the construct — so it
    // is replaced rather than escaped.
    .replace(/[\r\n]+/g, " ")
    .replace(/([[\]()\\])/g, "\\$1");

  // An image or a video both use the image form: the render plugin rewrites the `/video` one
  // into a <video> element after sanitisation.
  const prefix = attachment.kind === "file" ? "" : "!";
  return `${prefix}[${label}](${attachment.url})`;
}
