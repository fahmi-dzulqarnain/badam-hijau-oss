/**
 * The editor's save-state machine and conflict reducer.
 *
 * Pure: plain objects in, plain objects out, no React, no `fetch`, no Prisma — so every
 * branch of it unit-tests without a browser. The component owns the DOM, the network and
 * the CodeMirror view; it owns none of the decisions below.
 *
 * Timestamps are ISO strings here, not `Date`s, because that is the shape they have on the
 * wire in both directions: the endpoint returns `updatedAt` as an ISO string and the next
 * save must send that same string back as `seen`. Parsing it into a `Date` and
 * re-serialising it would introduce a round trip that can only lose.
 */

/** The other editor's work, as the 409 body carries it. */
export type OtherEdit = {
  title: string;
  markdown: string;
  /** ISO. What a "keep mine" must send as `seen` to overwrite this version explicitly. */
  updatedAt: string;
  editorName: string;
};

/** The text the refused save was carrying. Echoed by the endpoint so nothing is discarded. */
export type MyText = { title: string; markdown: string };

/**
 * `theirs` is null when the draft row vanished mid-edit — published (Task 9) or the page
 * deleted (Task 12). There is then no version to load and no version to overwrite, so the
 * banner has one action instead of two. See `saveStatusLabel` and the component.
 */
export type Conflict = { theirs: OtherEdit | null; mine: MyText };

export type SaveStatus =
  /** In sync with the server as far as this client knows. */
  | { kind: "clean" }
  /** Edited since the last successful save; a save is scheduled or about to be. */
  | { kind: "dirty" }
  | { kind: "saving" }
  /** Something went wrong and the text is NOT on the server. Always carries a sentence. */
  | { kind: "error"; message: string };

export type EditorState = {
  status: SaveStatus;
  /**
   * The `updatedAt` this client last received from the server, or null if it believes no
   * draft exists. Sent as `seen` on every save; the server treats a mismatch as a conflict
   * and treats a null against an existing draft as one too.
   */
  seen: string | null;
  /** ISO of the newest server-side save this client knows about, for "Saved 14:22". */
  savedAt: string | null;
  /** Set by a 409 and cleared only by an explicit resolution. Never by a keystroke. */
  conflict: Conflict | null;
};

export type EditorAction =
  | { type: "edited" }
  | { type: "save-started" }
  | { type: "saved"; updatedAt: string }
  | { type: "save-failed"; message: string }
  | { type: "conflicted"; conflict: Conflict }
  | { type: "keep-mine" }
  | { type: "load-theirs" }
  | { type: "dismissed" };

export function initialEditorState(seen: string | null): EditorState {
  return { status: { kind: "clean" }, seen, savedAt: seen, conflict: null };
}

/**
 * The two sentences a 409 turns into. Written here rather than in the component so the
 * `theirs === null` branch has exactly one wording — the one Task 5's route already
 * committed to when it chose to emit the key as null rather than omit it.
 */
const CONFLICT_STATUS = "Not saved — someone else edited this page";
const VANISHED_STATUS = "Not saved — this draft is gone";

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    /**
     * A keystroke. It does NOT clear the conflict: a banner that disappears when the user
     * starts typing again is a banner that resolved itself, and the whole point of the
     * conflict contract is that nobody's work is discarded without someone choosing to.
     */
    case "edited":
      // A keystroke never clears a failure. Every error message already begins "Not saved",
      // so replacing it with "Unsaved changes" would trade a sentence that says WHY for one
      // that only says THAT — and for the refusals nothing retries (403, 404) it would erase
      // the only explanation the person is ever going to get. Errors clear on a successful
      // save or an explicit resolution, and on nothing else.
      if (state.status.kind === "error") return state;
      // Identity-returned when already dirty, which is what lets the component dispatch on
      // every keystroke without thinking about it: React bails out of the re-render when a
      // reducer returns the state it was given. A fresh `{...state}` here would re-render
      // the whole editor once per character typed.
      return state.status.kind === "dirty" ? state : { ...state, status: { kind: "dirty" } };

    case "save-started":
      return { ...state, status: { kind: "saving" } };

    /**
     * The only place `seen` advances on its own. A successful save also clears the banner:
     * the user resolved it by choosing an action, and this is that choice landing.
     */
    case "saved":
      return {
        status: { kind: "clean" },
        seen: action.updatedAt,
        savedAt: action.updatedAt,
        conflict: null,
      };

    case "save-failed":
      return { ...state, status: { kind: "error", message: action.message } };

    /**
     * `seen` is deliberately NOT advanced here. Advancing it would make the very next
     * autosave a silent overwrite of the other editor's work — the auto-resolution this
     * whole mechanism exists to prevent. It moves only when the user picks "keep mine".
     */
    case "conflicted":
      return {
        ...state,
        status: {
          kind: "error",
          message: action.conflict.theirs === null ? VANISHED_STATUS : CONFLICT_STATUS,
        },
        conflict: action.conflict,
      };

    /**
     * An explicit overwrite of a version the user has been shown. Taking THEIR `updatedAt`
     * as `seen` is what makes the next save succeed instead of 409ing again — and it is
     * only defensible because the banner displayed their name, their timestamp and offered
     * the alternative first.
     *
     * The banner stays up until the save actually lands, so a "keep mine" that itself fails
     * does not leave the user believing they won.
     */
    case "keep-mine": {
      const theirs = state.conflict?.theirs;
      if (!theirs) return state;
      return { ...state, status: { kind: "dirty" }, seen: theirs.updatedAt };
    }

    /**
     * The user took the other version. The document now equals what the server holds, so
     * this is a clean state, not a dirty one — dispatching their text into the view must not
     * immediately schedule a save that writes it straight back.
     */
    case "load-theirs": {
      const theirs = state.conflict?.theirs;
      if (!theirs) return state;
      return {
        status: { kind: "clean" },
        seen: theirs.updatedAt,
        savedAt: theirs.updatedAt,
        conflict: null,
      };
    }

    /**
     * Only offered for the `theirs === null` branch, where neither other action exists.
     *
     * Clearing `seen` with it is the honest move rather than an extra one: the draft row the
     * timestamp referred to is gone, so continuing to claim it exists guarantees that every
     * later save 409s forever. With `seen` at null the next save creates a fresh draft — and
     * if a row has since reappeared, it conflicts again, correctly.
     */
    case "dismissed":
      if (state.conflict === null) return state;
      return {
        ...state,
        status: { kind: "dirty" },
        seen: state.conflict.theirs === null ? null : state.seen,
        conflict: null,
      };
  }
}

/**
 * Autosave is suspended while a conflict is unresolved.
 *
 * Not a nicety: with `seen` deliberately left stale by `conflicted`, an autosave that kept
 * firing would 409 every two seconds for as long as the tab stays open, and each reply
 * carries both full documents. The banner is a question, and the editor stops asking the
 * server anything until it is answered.
 */
export function shouldAutosave(state: EditorState): boolean {
  return state.conflict === null;
}

/**
 * The indicator's text. Never empty — every branch returns a sentence, and the test suite
 * asserts that across every reachable state. A blank indicator after a failed save looks
 * exactly like an idle editor with everything safely stored, which is how work gets lost.
 *
 * `formatTime` is passed in rather than imported so this stays pure, and so the component
 * can pass `null` for the first paint: the server renders this client component too, and a
 * time formatted in the server's zone and then again in the browser's is a hydration
 * mismatch. Before the mount effect runs the label reads "Saved"; after it, "Saved 14:22".
 */
export function saveStatusLabel(
  state: EditorState,
  formatTime: ((iso: string) => string) | null,
): string {
  switch (state.status.kind) {
    case "saving":
      return "Saving…";
    case "dirty":
      return "Unsaved changes";
    case "error":
      return state.status.message;
    case "clean":
      if (state.savedAt === null) return "Not saved yet";
      return formatTime === null ? "Saved" : `Saved ${formatTime(state.savedAt)}`;
  }
}
