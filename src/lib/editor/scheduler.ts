/**
 * The autosave clock.
 *
 * Pulled out of the component so the timing rules below are tested with fake timers instead
 * of being asserted by hand in a browser. It knows nothing about React, `fetch` or
 * CodeMirror: it decides *when* to call `save`, and the caller decides what saving means.
 *
 * Three rules, each of which has a way of going wrong that only shows up under real typing:
 *
 * 1. **The timer is armed by the first edit and is not re-armed by later ones.** A textbook
 *    debounce restarts on every keystroke, which means a person typing steadily for two
 *    minutes never saves once — the failure mode is invisible until the tab closes. Here the
 *    clock starts when the document goes from clean to dirty, so a save lands every
 *    `delayMs` during continuous typing and `delayMs` after the last keystroke otherwise.
 *    That is what spec §9's "autosave every 2 s" actually asks for.
 *
 * 2. **Never two saves in flight.** Two overlapping PUTs race on `seen`: the second carries
 *    a timestamp the first is about to invalidate, so it 409s against the user's own work
 *    and raises a conflict banner naming themselves.
 *
 * 3. **An edit that arrives during a save is not lost.** It re-arms the clock when the
 *    in-flight save resolves, so the last thing typed is always eventually written.
 */
export type SaveScheduler = {
  /** The document changed. Arms the clock if it is not already running. */
  edited(): void;
  /** Save now if there is anything to save — blur, tab hidden, navigating away. */
  flush(): void;
  /**
   * Whether there are edits the server has not been sent. Read by the caller immediately
   * after its own save resolves, to find out whether the user typed during the flight —
   * which is the difference between "Saved 14:22" being true and being a lie.
   */
  isDirty(): boolean;
  /** Teardown. Cancels the pending save and refuses every later one. */
  stop(): void;
};

export function createSaveScheduler(options: {
  delayMs: number;
  save: () => Promise<void>;
}): SaveScheduler {
  const { delayMs, save } = options;

  let dirty = false;
  let inFlight = false;
  let stopped = false;
  /** A `flush` that arrived while a save was running: run again the moment it finishes. */
  let flushWaiting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function arm(): void {
    // The `timer !== null` guard is rule 1. Replacing it with a clear-and-restart turns this
    // back into a debounce that starves under continuous typing.
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  }

  function disarm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function run(): Promise<void> {
    if (stopped || inFlight || !dirty) return;

    // Cleared BEFORE the await, not after: an edit arriving mid-save must set it again and
    // survive. Clearing it afterwards would swallow exactly the keystrokes typed during the
    // slowest saves, which are the ones most likely to be interrupted.
    dirty = false;
    inFlight = true;
    try {
      await save();
    } catch {
      // The caller reports failures — it is the only party that can say anything useful
      // about one. Swallowing it here is not hiding it; it is refusing to let a rejected
      // save wedge `inFlight` at true and silently end all further autosaving.
    } finally {
      inFlight = false;
      if (stopped) {
        flushWaiting = false;
      } else if (dirty && flushWaiting) {
        flushWaiting = false;
        void run();
      } else if (dirty) {
        arm();
      } else {
        flushWaiting = false;
      }
    }
  }

  return {
    edited() {
      if (stopped) return;
      dirty = true;
      arm();
    },

    flush() {
      if (stopped) return;
      disarm();
      if (inFlight) {
        // Do not start a second save. Rule 2 outranks promptness, and the save that is
        // already running will be followed immediately by another.
        flushWaiting = true;
        return;
      }
      void run();
    },

    isDirty() {
      return dirty;
    },

    stop() {
      stopped = true;
      flushWaiting = false;
      disarm();
    },
  };
}
