"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorState as CodeMirrorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSaveScheduler, type SaveScheduler } from "@/lib/editor/scheduler";
import { saveOutcome, shouldRetry } from "@/lib/editor/save";
import {
  editorReducer,
  initialEditorState,
  saveStatusLabel,
  shouldAutosave,
  type EditorState,
} from "@/lib/editor/state";

/** Spec §9. Also the interval a person notices as "it just saves", rather than a lag. */
const AUTOSAVE_MS = 2000;

export type EditorPage = {
  id: string;
  path: string;
  docType: string;
  status: string;
  spaceName: string;
  /** ISO, or null when no draft row exists yet. The first save's `seen`. */
  updatedAt: string | null;
  title: string;
  markdown: string;
};

/**
 * Marks a transaction as coming from us rather than from the keyboard.
 *
 * "Load theirs" replaces the whole document with a `dispatch`, and CodeMirror's update
 * listener cannot tell that apart from typing. Without this annotation the replacement would
 * mark the document dirty and schedule a save of the text we just took FROM the server —
 * writing their own version back over them, two seconds after resolving the conflict.
 */
const FromServer = Annotation.define<boolean>();

/**
 * `Saved 14:22`. Built lazily in the browser, never during the server render of this client
 * component: a time formatted in the server's zone and then again in the browser's is a
 * hydration mismatch, so the first paint gets `saveStatusLabel(..., null)` and no time.
 */
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

export function Editor({ page }: { page: EditorPage }) {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState(page.updatedAt));
  const [title, setTitle] = useState(page.title);
  const [hydrated, setHydrated] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const schedulerRef = useRef<SaveScheduler | null>(null);

  /**
   * Refs, not dependencies. Everything below is read from inside a CodeMirror listener, a
   * timer or a `fetch` continuation — callbacks that outlive the render that created them.
   * Putting these in a dependency array instead would rebuild the effect that owns the
   * `EditorView`, and rebuilding the view is the one thing this component must never do.
   */
  const stateRef = useRef<EditorState>(state);
  const titleRef = useRef(title);
  useEffect(() => {
    stateRef.current = state;
    titleRef.current = title;
  });

  useEffect(() => setHydrated(true), []);

  /**
   * One save. Reads the document out of the view at the moment it fires rather than from
   * React state, which is the other half of "do not round-trip the document per keystroke":
   * the text lives in CodeMirror and React never holds a copy of it.
   */
  const save = useCallback(
    async (override?: { seen: string | null }) => {
      const view = viewRef.current;
      if (!view) return;

      const mine = { title: titleRef.current, markdown: view.state.doc.toString() };
      // `override` is how "keep mine" re-sends with THEIR timestamp: an explicit overwrite
      // of a version the banner has already shown the user, decided at the click and not
      // read back out of a state that may not have committed yet.
      const seen = override ? override.seen : stateRef.current.seen;

      dispatch({ type: "save-started" });

      let status = 0;
      let body: unknown = null;
      try {
        // No `keepalive`. It would let a save survive the tab closing, but the flag caps the
        // body at 64KB across all in-flight keepalive requests — silently truncating exactly
        // the long documents most worth not losing. The blur and visibility flushes below
        // are the answer instead, and they are honest about their limits.
        const response = await fetch(`/api/drafts/${page.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...mine, seen }),
        });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch {
        dispatch({
          type: "save-failed",
          message: "Not saved — the browser could not reach the server",
        });
        // A request that never reached a server is the one failure always worth retrying —
        // `shouldRetry(0)`. The scheduler cleared its dirty flag when this save started, so
        // it has to be told there is still something to write; otherwise the work sits
        // unsaved until the next keystroke, and the person who has stopped typing is
        // precisely the one about to close the tab.
        schedulerRef.current?.edited();
        return;
      }

      const action = saveOutcome({ status, body, mine });
      dispatch(action);

      if (action.type === "saved" && schedulerRef.current?.isDirty()) {
        // They typed while this save was in flight, so "Saved 14:22" is already stale.
        // The scheduler has re-armed itself; this only stops the indicator from lying.
        dispatch({ type: "edited" });
      }
      if (action.type === "save-failed" && shouldRetry(status)) {
        schedulerRef.current?.edited();
      }
    },
    [page.id],
  );

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  /**
   * The scheduler, built once per page. It calls through a ref so that rebuilding `save`
   * never rebuilds the scheduler — a fresh scheduler would drop the pending save with it.
   */
  useEffect(() => {
    const scheduler = createSaveScheduler({
      delayMs: AUTOSAVE_MS,
      save: async () => {
        // The suspension `shouldAutosave` describes, enforced at the one place that can
        // enforce it. Measured in the browser without this check: the conflict banner
        // appeared, and then every further keystroke fired another PUT that 409'd again,
        // each reply carrying both full documents. The banner is a question, and the editor
        // asks the server nothing more until it is answered — by "keep mine", which saves
        // explicitly, by "load theirs", which leaves nothing to save, or by a dismiss.
        if (!shouldAutosave(stateRef.current)) return;
        await saveRef.current();
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      // Flush before stopping: `flush` starts the save synchronously up to its `fetch`, so
      // the document is read out of the still-live view before the cleanup below destroys
      // it. `stop` then prevents anything further being scheduled after unmount.
      scheduler.flush();
      scheduler.stop();
      schedulerRef.current = null;
    };
  }, [page.id]);

  /**
   * The `EditorView`, built ONCE and keyed on the page id.
   *
   * This is the rule the whole component is arranged around. A view rebuilt on render loses
   * the cursor, the selection, the undo history and the scroll position — and with a save
   * every two seconds, "on render" means several times a minute while someone is typing.
   * Nothing in this dependency array changes while the page stays the same.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: CodeMirrorState.create({
        doc: page.markdown,
        extensions: [
          basicSetup,
          markdown(),
          // Wrapping, not a horizontal scrollbar. A 3000-character unbroken line is the
          // shape that has widened this application's layout three times; `lineWrapping`
          // carries `overflow-wrap: anywhere`, so the line breaks instead of the page.
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // Our own document replacement is not an edit. See `FromServer`.
            if (update.transactions.some((tr) => tr.annotation(FromServer))) return;
            schedulerRef.current?.edited();
            dispatch({ type: "edited" });
          }),
          EditorView.domEventHandlers({
            // Also on blur, so a tab closed two seconds after the last keystroke does not
            // take those two seconds with it.
            blur: () => {
              schedulerRef.current?.flush();
              return false;
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // ONE dependency, and `page.markdown` is deliberately not among it. It is the SEED
    // document, read once; listing it would rebuild the whole view — cursor, undo history
    // and scroll position — the moment a router refresh re-rendered this route with newer
    // server text, which is precisely the destruction this effect exists to prevent. A new
    // page id is the only thing that justifies a new view.
  }, [page.id]);

  /**
   * A tab being hidden is the last reliable signal before it is closed or discarded. `blur`
   * covers clicking away inside the page; this covers switching tabs and closing the window.
   */
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") schedulerRef.current?.flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, []);

  const conflict = state.conflict;
  const theirs = conflict?.theirs ?? null;

  const loadTheirs = () => {
    const view = viewRef.current;
    if (!view || !theirs) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: theirs.markdown },
      annotations: FromServer.of(true),
    });
    setTitle(theirs.title);
    titleRef.current = theirs.title;
    dispatch({ type: "load-theirs" });
  };

  const keepMine = () => {
    if (!theirs) return;
    dispatch({ type: "keep-mine" });
    // Sent with their timestamp, explicitly, rather than waiting for the autosave tick —
    // which `shouldAutosave` is holding off anyway until this conflict is resolved.
    void saveRef.current({ seen: theirs.updatedAt });
  };

  /**
   * The one action the `theirs === null` banner offers. Autosave was suspended while it was
   * up and the scheduler was left thinking the document was clean, so it has to be told
   * there is still something to write — otherwise dismissing the banner would quietly stop
   * saving until the next keystroke.
   */
  const dismiss = () => {
    dispatch({ type: "dismissed" });
    schedulerRef.current?.edited();
  };

  const onTitleChange = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    schedulerRef.current?.edited();
    dispatch({ type: "edited" });
  };

  return (
    <main className="ed">
      <div className="ed-bar">
        <div className="ed-where">
          <span className="ed-space">{page.spaceName}</span>
          <span className="ed-sep">/</span>
          <span className="ed-path">{page.path}</span>
          <span className="ed-chip">{page.docType}</span>
          {page.status === "DRAFT" ? <span className="ed-chip">Unpublished</span> : null}
        </div>
        <span
          className={`ed-status ed-status-${state.status.kind}`}
          role="status"
          aria-live="polite"
        >
          {saveStatusLabel(state, hydrated ? formatTime : null)}
        </span>
      </div>

      {conflict ? (
        <div className="ed-conflict" role="alert">
          {theirs ? (
            <>
              <p className="ed-conflict-lead">
                <strong>{theirs.editorName}</strong> saved a newer version of this draft at{" "}
                {hydrated ? formatTime(theirs.updatedAt) : "the time shown on their save"}.
                Your changes have not been saved.
              </p>
              <p className="ed-conflict-body">
                <strong>Keep mine</strong> overwrites their version with what is in the
                editor now. <strong>Load theirs</strong> replaces the editor with their text
                and discards yours.
              </p>
              <div className="ed-conflict-actions">
                <button type="button" onClick={keepMine}>
                  Keep mine
                </button>
                <button type="button" onClick={loadTheirs}>
                  Load theirs
                </button>
              </div>
            </>
          ) : (
            <>
              {/*
                The `theirs: null` branch. Task 5's route decided this wording when it chose
                to emit the key as null rather than omit it, and it is repeated here rather
                than reinvented: there is no version to load and none to overwrite, so the
                only honest instruction is "your text is still in front of you; copy it".
              */}
              <p className="ed-conflict-lead">
                This page&rsquo;s draft was published or removed while you were editing. Your
                text is below and has not been saved; copy it somewhere before reloading.
              </p>
              <div className="ed-conflict-actions">
                <button type="button" onClick={dismiss}>
                  Dismiss and save as a new draft
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <label className="ed-label" htmlFor="ed-title">
        Title
      </label>
      <input
        id="ed-title"
        className="ed-title"
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        onBlur={() => schedulerRef.current?.flush()}
      />

      <label className="ed-label" htmlFor="ed-doc">
        Markdown
      </label>
      {/*
        CodeMirror owns everything inside this element. React must never render children
        into it — the two would fight over the same DOM nodes on the first re-render.
      */}
      <div className="ed-surface" id="ed-doc" ref={hostRef} />

      <p className="ed-hint">
        {shouldAutosave(state)
          ? "Saves automatically a couple of seconds after you stop typing, and when you click away."
          : "Autosave is paused until you answer the notice above."}
      </p>
    </main>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "an unknown time" : timeFormat.format(date);
}
