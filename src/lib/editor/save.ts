import type { EditorAction, MyText, OtherEdit } from "@/lib/editor/state";

/**
 * Turns one autosave response into one reducer action.
 *
 * Pure, and separate from the component for the same reason `decideSave` is separate from
 * the repository: this is where the conflict contract meets the wire, and every branch of it
 * — including the ones a browser will not produce on demand, like a 413 or a truncated body
 * — needs a test. A `switch` buried inside a `fetch` callback gets exactly the coverage of
 * the branches someone can reproduce by hand.
 *
 * Every failure branch returns a SENTENCE. The one thing this function must never do is
 * produce an empty message: `saveStatusLabel` renders it verbatim, and an empty indicator
 * after a failed save is indistinguishable from an editor whose work is safely stored.
 */
export function saveOutcome(args: {
  status: number;
  /** The parsed JSON body, or `null` if it was absent or unparseable. */
  body: unknown;
  /** What this save was carrying, so a 409 still has a `mine` if the body lacks one. */
  mine: MyText;
}): EditorAction {
  const { status, body, mine } = args;

  if (status === 200 || status === 201) {
    const updatedAt = readString(body, "updatedAt");
    // A 2xx whose body does not carry a usable timestamp cannot be treated as a save: the
    // next `seen` would be wrong and every save after it would 409 with nothing to
    // reconcile. Reporting it as a failure is the safe reading, and it is loud.
    if (updatedAt === null) {
      return { type: "save-failed", message: "Not saved — the server sent an unusable reply" };
    }
    return { type: "saved", updatedAt };
  }

  if (status === 409) {
    return {
      type: "conflicted",
      conflict: { theirs: readOtherEdit(body), mine: readMine(body) ?? mine },
    };
  }

  return { type: "save-failed", message: failureMessage(status) };
}

/**
 * Whether a refused save is worth trying again on the next tick, without the user doing
 * anything. `0` means the request never reached a server at all.
 *
 * The split matters in both directions. A dropped wifi connection that the editor does not
 * retry leaves the work stranded until the next keystroke — and the person most likely to
 * have stopped typing is the one about to close the tab. A 403 or a 404 that the editor DOES
 * retry produces a failing request every two seconds for the rest of the session, which
 * changes nothing and buries the one message that was worth reading.
 *
 * 409 is absent on purpose: it is not a failure to retry but a question to answer, and the
 * banner suspends autosave until it is.
 */
export function shouldRetry(status: number): boolean {
  return status === 0 || status >= 500;
}

function failureMessage(status: number): string {
  switch (status) {
    case 401:
      return "Not saved — your session ended. Sign in again in another tab, then retry";
    case 403:
      return "Not saved — you no longer have permission to edit this page";
    // The endpoint gives one answer for "gone" and "you cannot see it", and so does this.
    case 404:
      return "Not saved — this page is no longer available";
    case 413:
      return "Not saved — this document is too large to store";
    default:
      return `Not saved — the server refused the save (${status})`;
  }
}

/**
 * The 409's `theirs`, or null. Null is a real answer here, not a parse failure: Task 5's
 * route emits the key as null when the draft was published or deleted mid-edit, and it emits
 * the key rather than omitting it precisely so a client can tell that apart from a truncated
 * body. A partial object is treated as null too — a banner offering "load theirs" with an
 * undefined document is worse than a banner without the button.
 */
function readOtherEdit(body: unknown): OtherEdit | null {
  const theirs = readRecord(body)?.["theirs"];
  const title = readString(theirs, "title");
  const markdown = readString(theirs, "markdown");
  const updatedAt = readString(theirs, "updatedAt");
  const editorName = readString(theirs, "editorName");
  if (title === null || markdown === null || updatedAt === null || editorName === null) {
    return null;
  }
  return { title, markdown, updatedAt, editorName };
}

function readMine(body: unknown): MyText | null {
  const mine = readRecord(body)?.["mine"];
  const title = readString(mine, "title");
  const markdown = readString(mine, "markdown");
  return title === null || markdown === null ? null : { title, markdown };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string | null {
  const found = readRecord(value)?.[key];
  return typeof found === "string" ? found : null;
}
