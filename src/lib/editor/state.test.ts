import { expect, test } from "vitest";
import {
  editorReducer,
  initialEditorState,
  saveStatusLabel,
  shouldAutosave,
  type Conflict,
  type EditorState,
} from "@/lib/editor/state";

const THEIRS = {
  title: "MQTT contracts — Budi's title",
  markdown: "Budi's paragraph.",
  updatedAt: "2026-08-23T14:22:31.500Z",
  editorName: "Budi S.",
};

const MINE = { title: "MQTT contracts — my title", markdown: "My paragraph." };

const conflict: Conflict = { theirs: THEIRS, mine: MINE };
const vanished: Conflict = { theirs: null, mine: MINE };

const AT_LOAD = "2026-08-23T14:00:00.000Z";

function reduce(state: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) {
  return actions.reduce(editorReducer, state);
}

const clean = () => initialEditorState(AT_LOAD);

test("a freshly loaded draft is clean and knows the timestamp its next save must send", () => {
  const state = clean();
  expect(state.status).toEqual({ kind: "clean" });
  expect(state.seen).toBe(AT_LOAD);
  expect(state.savedAt).toBe(AT_LOAD);
  expect(state.conflict).toBeNull();
});

test("a page with no draft yet starts with no `seen` at all", () => {
  // Not the same as "clean with a timestamp": the first save must claim no draft exists, so
  // the server takes the create branch instead of conflicting against a row that is not there.
  const state = initialEditorState(null);
  expect(state.seen).toBeNull();
  expect(saveStatusLabel(state, () => "14:00")).toBe("Not saved yet");
});

test("a successful save advances `seen`, so the next one is not a conflict", () => {
  const state = reduce(
    clean(),
    { type: "edited" },
    { type: "save-started" },
    { type: "saved", updatedAt: "2026-08-23T14:02:00.000Z" },
  );
  expect(state.seen).toBe("2026-08-23T14:02:00.000Z");
  expect(state.savedAt).toBe("2026-08-23T14:02:00.000Z");
  expect(state.status).toEqual({ kind: "clean" });
});

test("a conflict does NOT advance `seen`", () => {
  // The mutation this kills: advancing `seen` to theirs on the 409 itself. Everything looks
  // right — the banner appears — and then the next autosave silently overwrites the other
  // editor two seconds later, with nobody having chosen anything.
  const state = reduce(clean(), { type: "edited" }, { type: "conflicted", conflict });
  expect(state.seen).toBe(AT_LOAD);
  expect(state.conflict).toEqual(conflict);
});

test("typing does not dismiss the conflict banner, nor the sentence beside it", () => {
  const state = reduce(
    clean(),
    { type: "conflicted", conflict },
    { type: "edited" },
    { type: "edited" },
  );
  expect(state.conflict).toEqual(conflict);
  expect(saveStatusLabel(state, null)).toBe("Not saved — someone else edited this page");
});

test("typing does not replace a failure message with `Unsaved changes`", () => {
  // Observed in the browser before this rule existed. Nothing retries a 403, so the moment
  // the person typed again the only explanation they were ever going to get was replaced by
  // a milder one that did not mention the refusal at all.
  const state = reduce(
    clean(),
    { type: "save-failed", message: "Not saved — you no longer have permission" },
    { type: "edited" },
  );
  expect(saveStatusLabel(state, null)).toBe("Not saved — you no longer have permission");
});

test("a retry that starts clears the failure message, and a success clears it for good", () => {
  const failed = reduce(
    clean(),
    { type: "save-failed", message: "Not saved — the browser could not reach the server" },
  );
  expect(saveStatusLabel(editorReducer(failed, { type: "save-started" }), null)).toBe(
    "Saving…",
  );
  const recovered = reduce(
    failed,
    { type: "save-started" },
    { type: "saved", updatedAt: THEIRS.updatedAt },
  );
  expect(saveStatusLabel(recovered, () => "14:22")).toBe("Saved 14:22");
});

test("a keystroke on an already-dirty document returns the same state object", () => {
  // The component dispatches on every character. Returning a fresh object each time would
  // re-render the whole editor per keystroke; React bails out when the reducer returns the
  // state it was handed, so this identity is the thing that keeps typing cheap.
  const dirty = editorReducer(clean(), { type: "edited" });
  expect(editorReducer(dirty, { type: "edited" })).toBe(dirty);
  expect(editorReducer(clean(), { type: "edited" })).not.toBe(clean());
});

test("autosave is suspended while a conflict is unresolved, and resumes after either action", () => {
  expect(shouldAutosave(clean())).toBe(true);

  const conflicted = editorReducer(clean(), { type: "conflicted", conflict });
  expect(shouldAutosave(conflicted)).toBe(false);
  expect(shouldAutosave(editorReducer(conflicted, { type: "edited" }))).toBe(false);

  expect(shouldAutosave(editorReducer(conflicted, { type: "load-theirs" }))).toBe(true);
  // "keep mine" leaves the banner up until the save lands, so autosave stays suspended and
  // the explicit re-send is the only write that happens.
  expect(shouldAutosave(editorReducer(conflicted, { type: "keep-mine" }))).toBe(false);
});

test("keep mine re-sends with THEIR timestamp, and keeps the banner until the save lands", () => {
  const kept = reduce(clean(), { type: "conflicted", conflict }, { type: "keep-mine" });
  expect(kept.seen).toBe(THEIRS.updatedAt);
  expect(kept.status).toEqual({ kind: "dirty" });
  expect(kept.conflict).toEqual(conflict);

  const landed = reduce(
    kept,
    { type: "save-started" },
    { type: "saved", updatedAt: "2026-08-23T14:25:00.000Z" },
  );
  expect(landed.conflict).toBeNull();
  expect(landed.seen).toBe("2026-08-23T14:25:00.000Z");
});

test("a keep mine that itself fails leaves the banner up", () => {
  const state = reduce(
    clean(),
    { type: "conflicted", conflict },
    { type: "keep-mine" },
    { type: "save-started" },
    { type: "save-failed", message: "Not saved — the server refused the save (500)" },
  );
  expect(state.conflict).toEqual(conflict);
  expect(state.status).toEqual({
    kind: "error",
    message: "Not saved — the server refused the save (500)",
  });
});

test("load theirs lands clean on their timestamp and does not schedule a write-back", () => {
  const state = reduce(clean(), { type: "conflicted", conflict }, { type: "load-theirs" });
  expect(state.status).toEqual({ kind: "clean" });
  expect(state.seen).toBe(THEIRS.updatedAt);
  expect(state.savedAt).toBe(THEIRS.updatedAt);
  expect(state.conflict).toBeNull();
});

test("neither resolution does anything when there is no `theirs` to resolve against", () => {
  const state = editorReducer(clean(), { type: "conflicted", conflict: vanished });
  expect(editorReducer(state, { type: "keep-mine" })).toBe(state);
  expect(editorReducer(state, { type: "load-theirs" })).toBe(state);
  // Neither action is rendered in that branch; this pins that a hand-fired one cannot
  // resolve a conflict by reading `updatedAt` off a null.
  expect(state.conflict).toEqual(vanished);
});

test("dismissing a vanished draft clears `seen`, so the next save creates rather than 409s forever", () => {
  const state = reduce(
    clean(),
    { type: "conflicted", conflict: vanished },
    { type: "dismissed" },
  );
  expect(state.conflict).toBeNull();
  expect(state.seen).toBeNull();
  expect(state.status).toEqual({ kind: "dirty" });
});

test("dismissing is inert when there is no banner", () => {
  const state = clean();
  expect(editorReducer(state, { type: "dismissed" })).toBe(state);
});

test("the two conflict branches say different things in the indicator", () => {
  const label = (c: Conflict) =>
    saveStatusLabel(editorReducer(clean(), { type: "conflicted", conflict: c }), null);
  expect(label(conflict)).toBe("Not saved — someone else edited this page");
  expect(label(vanished)).toBe("Not saved — this draft is gone");
});

test("the indicator moves Saving… → Saved 14:22 → Unsaved changes", () => {
  const format = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(new Date(iso));

  const dirty = editorReducer(clean(), { type: "edited" });
  expect(saveStatusLabel(dirty, format)).toBe("Unsaved changes");

  const saving = editorReducer(dirty, { type: "save-started" });
  expect(saveStatusLabel(saving, format)).toBe("Saving…");

  const saved = editorReducer(saving, { type: "saved", updatedAt: THEIRS.updatedAt });
  expect(saveStatusLabel(saved, format)).toBe("Saved 14:22");
});

test("the indicator reads `Saved` without a time before the mount effect runs", () => {
  // The server renders this client component too. Formatting a timestamp in the server's
  // zone and again in the browser's is a hydration mismatch, so the first paint gets no time.
  expect(saveStatusLabel(clean(), null)).toBe("Saved");
});

test("no reachable state renders a blank indicator", () => {
  const start = clean();
  const states: EditorState[] = [
    start,
    initialEditorState(null),
    editorReducer(start, { type: "edited" }),
    editorReducer(start, { type: "save-started" }),
    editorReducer(start, { type: "saved", updatedAt: THEIRS.updatedAt }),
    editorReducer(start, { type: "save-failed", message: "Not saved — offline" }),
    editorReducer(start, { type: "conflicted", conflict }),
    editorReducer(start, { type: "conflicted", conflict: vanished }),
    reduce(start, { type: "conflicted", conflict }, { type: "keep-mine" }),
    reduce(start, { type: "conflicted", conflict }, { type: "load-theirs" }),
    reduce(start, { type: "conflicted", conflict: vanished }, { type: "dismissed" }),
  ];

  for (const state of states) {
    for (const format of [null, () => "14:22"] as const) {
      expect(saveStatusLabel(state, format).trim(), JSON.stringify(state)).not.toBe("");
    }
  }
});

test("a failed save keeps the timestamp it last really saw", () => {
  // The mutation this kills: clearing `savedAt` on failure. The editor would then show
  // "Not saved yet" over a draft that IS stored, and the honest reading of that is "start
  // over", which is the opposite of what happened.
  const state = reduce(
    clean(),
    { type: "edited" },
    { type: "save-started" },
    { type: "save-failed", message: "Not saved — offline" },
  );
  expect(state.savedAt).toBe(AT_LOAD);
  expect(state.seen).toBe(AT_LOAD);
});
