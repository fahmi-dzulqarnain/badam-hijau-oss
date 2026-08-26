import { expect, test } from "vitest";
import {
  contentDisposition,
  driveKeyFor,
  extensionFor,
  isAllowedMime,
  isInlineMime,
} from "./policy";

test("the allowlist admits rasters, video and documents", () => {
  for (const mime of ["image/png", "image/jpeg", "video/mp4", "application/pdf"]) {
    expect(isAllowedMime(mime), mime).toBe(true);
  }
});

test("SVG and HTML are allowed as UPLOADS but never served inline", () => {
  // Refusing the upload outright would be a worse trade: an SVG diagram is a legitimate
  // attachment. The safety comes from how it is SERVED, not from refusing to store it.
  expect(isAllowedMime("image/svg+xml")).toBe(true);
  expect(isInlineMime("image/svg+xml")).toBe(false);
  expect(isAllowedMime("text/html")).toBe(true);
  expect(isInlineMime("text/html")).toBe(false);
});

test("an unknown mime is refused", () => {
  expect(isAllowedMime("application/x-msdownload")).toBe(false);
  expect(isAllowedMime("")).toBe(false);
});

test("a plain filename is quoted, and inline types say inline", () => {
  expect(contentDisposition("image/png", "shot.png")).toBe('inline; filename="shot.png"');
  expect(contentDisposition("application/pdf", "report.pdf")).toBe(
    'attachment; filename="report.pdf"',
  );
});

test("a non-ASCII filename gets an RFC 5987 form alongside an ASCII fallback", () => {
  expect(contentDisposition("application/pdf", "laporan-kewangan-²⁰²⁵.pdf")).toBe(
    "attachment; filename=\"laporan-kewangan-.pdf\"; filename*=UTF-8''laporan-kewangan-%C2%B2%E2%81%B0%C2%B2%E2%81%B5.pdf",
  );
});

test("a filename cannot inject a header", () => {
  // The whole reason this function exists rather than a template literal at the call site.
  // CR and LF end a header; a bare quote ends the quoted-string and lets the rest of the
  // filename be read as further parameters.
  const hostile = 'ok".\r\nSet-Cookie: a=b\r\nX: "y.png';
  const header = contentDisposition("image/png", hostile);
  expect(header).not.toMatch(/[\r\n]/);
  expect(header.match(/"/g)).toHaveLength(2);
});

test("an empty or dot-only filename falls back to the attachment id's shape", () => {
  expect(contentDisposition("image/png", "")).toBe('inline; filename="file.png"');
  expect(contentDisposition("image/png", "..")).toBe('inline; filename="file.png"');
});

test("the drive key shards on the id prefix and carries the extension", () => {
  expect(driveKeyFor("ckabcdef0000", "image/png")).toBe("ck/ckabcdef0000.png");
  expect(extensionFor("video/mp4")).toBe(".mp4");
});

test("the drive key is a pure function of id and mime", () => {
  // Not of the date: `createdAt` is a database default, so it is unknown at the moment the
  // key must be computed. See the plan's correction #2.
  expect(driveKeyFor("aa1", "image/png")).toBe(driveKeyFor("aa1", "image/png"));
});
