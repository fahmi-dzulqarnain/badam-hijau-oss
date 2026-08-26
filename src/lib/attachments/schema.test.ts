import { expect, test } from "vitest";
import { beginUploadInput, MAX_UPLOAD_BYTES, maxUploadBytes } from "./schema";

test("a well-formed request parses", () => {
  const parsed = beginUploadInput.parse({
    pageId: "ckpage1",
    filename: "shot.png",
    mimeType: "image/png",
    sizeBytes: 1024,
  });
  expect(parsed.filename).toBe("shot.png");
});

test("a mime off the allowlist is rejected here, before any session is minted", () => {
  expect(
    beginUploadInput.safeParse({
      pageId: "ckpage1", filename: "x.exe",
      mimeType: "application/x-msdownload", sizeBytes: 10,
    }).success,
  ).toBe(false);
});

test("a size over the cap, at zero, or fractional is rejected", () => {
  for (const sizeBytes of [MAX_UPLOAD_BYTES + 1, 0, -1, 1.5]) {
    expect(
      beginUploadInput.safeParse({
        pageId: "ckpage1", filename: "a.png", mimeType: "image/png", sizeBytes,
      }).success,
      String(sizeBytes),
    ).toBe(false);
  }
});

test("control characters are stripped from the filename", () => {
  const parsed = beginUploadInput.parse({
    pageId: "ckpage1", filename: "a\u0000b\r\n.png", mimeType: "image/png", sizeBytes: 1,
  });
  expect(parsed.filename).toBe("ab.png");
});

test("the default cap stays inside Attachment.sizeBytes, which is an Int", () => {
  // Postgres `integer` is 4 bytes. A cap at or above 2^31 admits a row that cannot be
  // written, and the failure would land after the upload succeeded.
  expect(MAX_UPLOAD_BYTES).toBeLessThan(2_147_483_647);
});

test("maxUploadBytes refuses a non-numeric or oversized override rather than guessing", () => {
  expect(maxUploadBytes({ MAX_UPLOAD_BYTES: "1048576" })).toBe(1_048_576);
  expect(() => maxUploadBytes({ MAX_UPLOAD_BYTES: "lots" })).toThrow(/MAX_UPLOAD_BYTES/);
  expect(() => maxUploadBytes({ MAX_UPLOAD_BYTES: "3000000000" })).toThrow(/Int/);
});
