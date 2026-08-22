import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { createBugReport } from "@/lib/bugs/create";

beforeEach(resetDb);

async function reporter() {
  return db.user.create({
    data: { email: "reporter@example.com", name: "Reporter" },
  });
}

const input = {
  summary: "The TOC jumps to the wrong heading",
  expected: null,
  routePath: "/engineering/decisions/adr-0042",
  appVersion: "0.1.0",
  gitSha: "df0ef11",
  userAgent: "Mozilla/5.0",
  viewport: "1440x900",
  consoleError: null,
};

const noContext = { spaceId: null, pageId: null, versionId: null };

test("stores a report as NEW against its reporter", async () => {
  const user = await reporter();
  const report = await createBugReport(user.id, input, noContext);

  expect(report.status).toBe("NEW");
  expect(report.reporterId).toBe(user.id);
  expect(report.gitSha).toBe("df0ef11");
});

test("keeps the captured context verbatim", async () => {
  const user = await reporter();
  const report = await createBugReport(
    user.id,
    { ...input, consoleError: "TypeError: x is not a function" },
    noContext,
  );

  const stored = await db.bugReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(stored.routePath).toBe("/engineering/decisions/adr-0042");
  expect(stored.viewport).toBe("1440x900");
  expect(stored.consoleError).toBe("TypeError: x is not a function");
});

test("stores the server-derived context alongside the report", async () => {
  const user = await reporter();
  const report = await createBugReport(user.id, input, {
    spaceId: "sp-1",
    pageId: "pg-1",
    versionId: "ver-1",
  });

  const stored = await db.bugReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(stored.spaceId).toBe("sp-1");
  expect(stored.pageId).toBe("pg-1");
  expect(stored.versionId).toBe("ver-1");
});

test("several reports from one user are all kept", async () => {
  const user = await reporter();
  await createBugReport(user.id, input, noContext);
  await createBugReport(user.id, { ...input, summary: "Second problem" }, noContext);

  expect(await db.bugReport.count()).toBe(2);
});
