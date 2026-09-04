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

test("SVG and HTML are refused as uploads, because this app is not the only reader", () => {
  // These were uploadable, on the reasoning that safety comes from how a file is SERVED — and
  // that reasoning was sound about *this* application and incomplete about the system. The
  // bytes live in a SharePoint document library, and **SharePoint's own web UI serves them
  // too**, to anyone with access to the site, with none of this route's headers: no
  // `nosniff`, no forced `octet-stream`, no permission predicate. An uploaded SVG or HTML
  // file is script execution waiting on a URL we do not control and cannot add a header to.
  //
  // So the refusal moved to the only point that governs both readers: what may be stored at
  // all. The cost is real and was accepted deliberately — an SVG diagram is a legitimate
  // attachment, and Mermaid fences already cover the case that motivated it.
  expect(isAllowedMime("image/svg+xml")).toBe(false);
  expect(isAllowedMime("text/html")).toBe(false);
});

test("a stored SVG or HTML row is still never served inline", () => {
  // Not redundant with the refusal above, and not dead code: `isInlineMime` is asked about the
  // `mimeType` on a row that already EXISTS, so it answers for rows written before the
  // allowlist narrowed. The upload gate and the serving gate are two independent defences and
  // this is the second one — removing it would make the read route depend on the allowlist
  // having always had its current contents.
  expect(isInlineMime("image/svg+xml")).toBe(false);
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

test("the drive key is a two-hex shard, the id, and the extension", () => {
  expect(driveKeyFor("ckabcdef0000", "image/png")).toMatch(/^[0-9a-f]{2}\/ckabcdef0000\.png$/);
  expect(extensionFor("video/mp4")).toBe(".mp4");
});

test("the drive key is a pure function of id and mime", () => {
  // Not of the date: `createdAt` is a database default, so it is unknown at the moment the
  // key must be computed.
  expect(driveKeyFor("aa1", "image/png")).toBe(driveKeyFor("aa1", "image/png"));
});

test("consecutively minted cuids do NOT collapse into one shard", () => {
  // The regression guard, and the whole reason the shard is hashed rather than sliced.
  // These are twelve REAL ids, minted back to back by Prisma against this schema.
  const ids = [
    "cmtacm2a80005yd0p8u3izx4i", "cmtacm2af0007yd0p9nv5e99l",
    "cmtacm2ag0009yd0pw835iijm", "cmtacm2ag000byd0pmepp3lhv",
    "cmtacm2ah000dyd0pfu2shv3k", "cmtacm2ai000fyd0p5px9y794",
    "cmtacm2aj000hyd0p9h4i7kc6", "cmtacm2ak000jyd0paoil0tdj",
    "cmtacm2ak000lyd0pb9hp209z", "cmtacm2ak000nyd0p4up54j01",
    "cmtacm2al000pyd0pvy3ct2jq", "cmtacm2al000ryd0p0tcvqx31",
  ];

  // What the code used to do, pinned so the failure is legible rather than mysterious: a
  // cuid is "c" + a base-36 millisecond timestamp + counter + fingerprint + random, so the
  // leading two characters are effectively constant for years. If THIS assertion ever fails,
  // Prisma's id format changed — which is information, not a broken test.
  expect(new Set(ids.map((id) => id.slice(0, 2))).size).toBe(1);

  const shards = new Set(ids.map((id) => driveKeyFor(id, "image/png").slice(0, 2)));
  expect(shards.size).toBe(ids.length);
});

test("a thousand near-identical ids spread across most of the bucket space", () => {
  // Tests the class rather than the corpus. The twelve ids above are a fixed sample and a
  // hash could pass them by luck; this asserts the property that matters — that ids sharing
  // a long prefix, which is exactly what sequential cuids are, still scatter.
  const ids = Array.from({ length: 1000 }, (_, i) => `cmtacm2a${String(i).padStart(6, "0")}yd0p`);
  const shards = new Set(ids.map((id) => driveKeyFor(id, "image/png").slice(0, 2)));

  // 256 buckets, 1000 draws: coupon-collector says essentially all of them should appear.
  // 200 is a floor well clear of chance, not a target.
  expect(shards.size).toBeGreaterThan(200);
});
