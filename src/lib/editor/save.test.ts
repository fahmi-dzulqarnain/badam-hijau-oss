import { expect, test } from "vitest";
import { saveOutcome, shouldRetry } from "@/lib/editor/save";

const MINE = { title: "My title", markdown: "My paragraph." };

const THEIRS = {
  title: "Budi's title",
  markdown: "Budi's paragraph.",
  updatedAt: "2026-08-23T14:22:31.500Z",
  editorName: "Budi S.",
};

test("201 and 200 both mean saved, and both carry the timestamp the next save must send", () => {
  for (const status of [200, 201]) {
    expect(
      saveOutcome({
        status,
        body: { title: "t", markdown: "m", updatedAt: "2026-08-23T14:02:00.000Z" },
        mine: MINE,
      }),
    ).toEqual({ type: "saved", updatedAt: "2026-08-23T14:02:00.000Z" });
  }
});

test("a 2xx without a usable timestamp is a failure, not a save", () => {
  // Treating it as a save would set `seen` to undefined and 409 every save afterwards with
  // nothing to reconcile — a permanently broken editor that says "Saved" the whole time.
  for (const body of [null, {}, { updatedAt: 1755960000000 }, { updatedAt: null }]) {
    const outcome = saveOutcome({ status: 200, body, mine: MINE });
    expect(outcome.type).toBe("save-failed");
  }
});

test("409 carries their edit and my text through to the banner", () => {
  expect(
    saveOutcome({
      status: 409,
      body: { error: "conflict", theirs: THEIRS, mine: MINE },
      mine: { title: "ignored", markdown: "ignored" },
    }),
  ).toEqual({ type: "conflicted", conflict: { theirs: THEIRS, mine: MINE } });
});

test("409 with `theirs: null` is the published-or-deleted branch, not a parse failure", () => {
  // Task 5's route emits the key as null rather than omitting it, exactly so this is
  // distinguishable from a truncated body. The banner it produces has one action.
  const outcome = saveOutcome({
    status: 409,
    body: { error: "conflict", theirs: null, mine: MINE },
    mine: MINE,
  });
  expect(outcome).toEqual({ type: "conflicted", conflict: { theirs: null, mine: MINE } });
});

test("a half-built `theirs` is treated as no `theirs` at all", () => {
  // A "load theirs" button that would insert `undefined` into the document is worse than
  // no button. Each field is required because the banner renders each one.
  for (const theirs of [
    { markdown: "m", updatedAt: THEIRS.updatedAt, editorName: "B" },
    { title: "t", updatedAt: THEIRS.updatedAt, editorName: "B" },
    { title: "t", markdown: "m", editorName: "B" },
    { title: "t", markdown: "m", updatedAt: THEIRS.updatedAt },
    "not an object",
  ]) {
    const outcome = saveOutcome({ status: 409, body: { theirs, mine: MINE }, mine: MINE });
    expect(outcome).toEqual({ type: "conflicted", conflict: { theirs: null, mine: MINE } });
  }
});

test("a 409 whose body lost `mine` falls back to the text the save was carrying", () => {
  const outcome = saveOutcome({ status: 409, body: { theirs: THEIRS }, mine: MINE });
  expect(outcome).toEqual({ type: "conflicted", conflict: { theirs: THEIRS, mine: MINE } });
});

test("every refusal names itself in a sentence, and none of them is empty", () => {
  const messages = [401, 403, 404, 411, 413, 400, 500, 502].map((status) => {
    const outcome = saveOutcome({ status, body: null, mine: MINE });
    expect(outcome.type).toBe("save-failed");
    return outcome.type === "save-failed" ? outcome.message : "";
  });

  for (const message of messages) expect(message.trim()).not.toBe("");
  // The four the editor can actually provoke are worded for the person, not the protocol.
  expect(messages[0]).toContain("session ended");
  expect(messages[1]).toContain("permission");
  expect(messages[2]).toContain("no longer available");
  expect(messages[4]).toContain("too large");
  // Anything unforeseen still says the status, so a bug report has something in it.
  expect(messages[6]).toContain("500");
});

test("404 does not say the page was deleted", () => {
  // The endpoint gives one answer for "gone" and "in a space you cannot read", and the
  // banner must not undo that by guessing which one it was.
  const outcome = saveOutcome({ status: 404, body: null, mine: MINE });
  expect(outcome.type === "save-failed" && outcome.message).not.toContain("deleted");
});

test("a save the network never delivered is retried; one the server rejected is not", () => {
  // Retrying a 403 forever changes nothing and buries the message that was worth reading.
  // Not retrying a dropped connection strands the work until the next keystroke — and the
  // person who has stopped typing is the one about to close the tab.
  expect(shouldRetry(0)).toBe(true);
  expect(shouldRetry(500)).toBe(true);
  expect(shouldRetry(502)).toBe(true);

  for (const status of [400, 401, 403, 404, 409, 411, 413]) {
    expect(shouldRetry(status), `${status} should not be retried`).toBe(false);
  }
});
