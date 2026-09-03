import { expect, test } from "vitest";
import { referenceFor } from "./reference";

test("an image becomes an image reference", () => {
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "shot.png", kind: "image" }))
    .toBe("![shot.png](/api/attachments/a1)");
});

test("a video uses the /video url the render plugin matches", () => {
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1/video", filename: "clip.mp4", kind: "video" }))
    .toBe("![clip.mp4](/api/attachments/a1/video)");
});

test("a document becomes a link, not an image", () => {
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "report.pdf", kind: "file" }))
    .toBe("[report.pdf](/api/attachments/a1)");
});

test("a filename containing brackets or parens cannot break out of the reference", () => {
  // Otherwise a file called `a](x` rewrites the document's link structure — the Markdown
  // equivalent of the header-injection case in policy.ts.
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "a](x).png", kind: "image" }))
    .toBe("![a\\]\\(x\\).png](/api/attachments/a1)");
});

test("a newline in a filename is replaced, not escaped", () => {
  // A newline ends the reference outright; there is no escape for it in link text.
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "a\nb.png", kind: "image" }))
    .toBe("![a b.png](/api/attachments/a1)");
});
