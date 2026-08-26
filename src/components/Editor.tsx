"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorState as CodeMirrorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSaveScheduler, type SaveScheduler } from "@/lib/editor/scheduler";
import { saveOutcome, shouldRetry } from "@/lib/editor/save";
import {
  dormantNotice,
  minimalReplacement,
  publishOutcome,
  readFrontmatterStatus,
  setFrontmatterStatus,
  type PublishOutcome,
} from "@/lib/editor/publish";
import { DocBody } from "@/components/DocBody";
import {
  editorReducer,
  initialEditorState,
  saveStatusLabel,
  shouldAutosave,
  type EditorAction,
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
  /**
   * The statuses this page can be published into **from the status it is in now** —
   * `publishDestinations`, computed on the server from `PUBLISHABLE_INTO`.
   *
   * Not the doc type's whole vocabulary, and not a list this component builds. Spec §6.1 owns
   * the vocabulary and §6.3 says it is never maintained in two places; a menu with its own idea
   * of the legal statuses would offer an `ACCEPTED` ADR a `PROPOSED` that publish then refuses,
   * and would hide a legal choice the day a row is widened.
   */
  statusOptions: readonly string[];
  /**
   * Where a publish lands when the document declares no `status:` —
   * `defaultPublishStatus(docType, status)`, again from the server.
   *
   * The picker shows it as the current selection **without writing it**: a control that edited
   * the document on mount would mark every page dirty the moment it was opened, and autosave
   * would write a version of the file nobody typed.
   */
  defaultStatus: string;
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

/**
 * The preview pane's contents.
 *
 * `html` is kept through a failure on purpose: a pane that empties itself the moment a
 * render fails throws away the last true thing it had to show, and the failures here are
 * mostly transient. It is labelled stale instead — an old preview the reader is told is old
 * beats a blank rectangle, and beats a fresh-looking one that is silently out of date.
 */
type PreviewState = { html: string; pending: boolean; error: string | null };

export function Editor({ page }: { page: EditorPage }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState(page.updatedAt));
  const [title, setTitle] = useState(page.title);
  const [hydrated, setHydrated] = useState(false);
  /**
   * Publishing is its own state, not a `SaveStatus`. A failed publish and a failed save are
   * different failures with different remedies, and folding them into one indicator would
   * mean a publish refusal wiping out the save state — or, worse, "Saved 14:22" sitting
   * beside a publish that did not happen.
   *
   * `outcome` is whatever `publishOutcome` made of the last reply, unchanged — including the
   * `published` branch, which this surface now sometimes has to *render* rather than navigate
   * away from. See `publish` below.
   */
  const [publishing, setPublishing] = useState<{
    pending: boolean;
    outcome: PublishOutcome | null;
  }>({ pending: false, outcome: null });
  /**
   * The `status:` the document declares, as text, or null when it declares none.
   *
   * React state and not a read of the view, because it has to drive a `<select>`. Kept in step
   * by the update listener, which re-reads a **bounded prefix** of the document rather than the
   * whole of it — the alternative is a full `doc.toString()` per keystroke, and this component's
   * first rule is that typing costs nothing it does not have to.
   */
  const [declaredStatus, setDeclaredStatus] = useState<string | null>(() =>
    readFrontmatterStatus(page.markdown),
  );
  const [preview, setPreview] = useState<PreviewState>({
    html: "",
    pending: true,
    error: null,
  });

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const schedulerRef = useRef<SaveScheduler | null>(null);
  const previewRef = useRef<SaveScheduler | null>(null);
  /**
   * Which preview render is the current one. The scheduler below guarantees its own renders
   * never overlap, but the render on mount is fired outside it, so two answers can still be
   * in flight at once — and the older one arriving second would leave the pane showing text
   * the document no longer contains.
   */
  const previewTicket = useRef(0);

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
   *
   * It **returns the action it dispatched**, so a caller that needs to know whether the save
   * landed can read the outcome rather than the reducer state. Publish is that caller, and
   * the distinction matters: `dispatch` is asynchronous, so the state a click handler can see
   * immediately after awaiting a save is still the state from before it.
   */
  const save = useCallback(
    async (override?: { seen: string | null }): Promise<EditorAction | null> => {
      const view = viewRef.current;
      if (!view) return null;

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
        const offline: EditorAction = {
          type: "save-failed",
          message: "Not saved — the browser could not reach the server",
        };
        dispatch(offline);
        // A request that never reached a server is the one failure always worth retrying —
        // `shouldRetry(0)`. The scheduler cleared its dirty flag when this save started, so
        // it has to be told there is still something to write; otherwise the work sits
        // unsaved until the next keystroke, and the person who has stopped typing is
        // precisely the one about to close the tab.
        schedulerRef.current?.edited();
        return offline;
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
      return action;
    },
    [page.id],
  );

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  /**
   * One preview render, on the server, through the reader's own pipeline.
   *
   * The route calls `renderMarkdown` — the function the reader calls — which is the whole
   * reason this is a round trip rather than a Markdown parser in the bundle. A client-side
   * approximation would be faster and would let the preview and the published page disagree
   * for exactly the documents nobody thought to test.
   *
   * Deliberately independent of saving. Preview must keep working while autosave is
   * suspended behind an unanswered conflict, and must not stop because a save failed: they
   * answer different questions and one being broken is not a reason to blind the other.
   */
  const renderPreview = useCallback(
    async (markdown: string) => {
      const ticket = ++previewTicket.current;
      const stale = () => ticket !== previewTicket.current;
      const failed = (message: string) =>
        setPreview((current) => ({ html: current.html, pending: false, error: message }));

      setPreview((current) => ({ ...current, pending: true }));

      let response: Response;
      try {
        response = await fetch("/api/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pageId: page.id, markdown }),
        });
      } catch {
        if (stale()) return;
        failed("Preview unavailable — the browser could not reach the server.");
        return;
      }
      if (stale()) return;

      if (!response.ok) {
        // The 403 is worth its own sentence: it means the membership was revoked while this
        // tab stayed open, so the next autosave is about to fail too, and "preview failed"
        // on its own would send someone hunting for a rendering bug.
        failed(
          response.status === 403
            ? "Preview stopped — you no longer have permission to edit this page."
            : response.status === 413
              ? "This document is too large to preview."
              : "Preview failed. Saving is unaffected.",
        );
        return;
      }

      const body = await response.json().catch(() => null);
      if (stale()) return;
      if (typeof body?.html !== "string") {
        failed("Preview failed. Saving is unaffected.");
        return;
      }
      setPreview({ html: body.html, pending: false, error: null });
    },
    [page.id],
  );

  const renderPreviewRef = useRef(renderPreview);
  useEffect(() => {
    renderPreviewRef.current = renderPreview;
  }, [renderPreview]);

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
   * The preview clock. Deliberately `createSaveScheduler` again rather than a second timer:
   * "same 2 s tick as autosave" is not a coincidence to be re-implemented, and every rule
   * that module encodes is a rule the preview wants too — armed by the first edit so steady
   * typing still refreshes rather than starving, never two requests in flight, and an edit
   * that lands mid-request re-arms so the pane cannot settle on stale HTML. Only the work it
   * schedules is different.
   */
  useEffect(() => {
    const scheduler = createSaveScheduler({
      delayMs: AUTOSAVE_MS,
      save: async () => {
        const view = viewRef.current;
        if (!view) return;
        // Read out of the view at the moment it fires, exactly as the save does. React never
        // holds a copy of the document.
        await renderPreviewRef.current(view.state.doc.toString());
      },
    });
    previewRef.current = scheduler;
    return () => {
      // No flush here, unlike the save scheduler: an unmounting preview has nothing to
      // persist, and firing a render into a component that is going away only spends a
      // request. Losing an unsaved *save* is data loss; losing an unrendered preview is not.
      scheduler.stop();
      previewRef.current = null;
    };
  }, [page.id]);

  /**
   * The first render, so the pane is populated before anyone types.
   *
   * From `page.markdown` — the same seed the view is built from — and keyed on the page id
   * alone for the same reason the view is: a router refresh that brings newer server text
   * must not repaint the preview out from under a document the editor is still holding, or
   * the two panes would disagree, which is the one thing this feature exists to prevent.
   */
  useEffect(() => {
    void renderPreviewRef.current(page.markdown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            // The status picker's own write lands here too, deliberately: it IS an edit, it has
            // to be saved like one, and this is what keeps the select in step with a `status:`
            // the author types by hand.
            //
            // A bounded prefix, never `doc.toString()`. `MAX_FRONTMATTER_BYTES` is 16KB, so any
            // block the publish path will accept is inside this window; a `status:` beyond it
            // belongs to a document publish refuses anyway, and the cost of being sure would be
            // copying the whole file on every keystroke.
            setDeclaredStatus(
              readFrontmatterStatus(
                update.state.doc.sliceString(0, Math.min(update.state.doc.length, 20_000)),
              ),
            );
            // Our own document replacement is not an edit. See `FromServer`.
            if (update.transactions.some((tr) => tr.annotation(FromServer))) return;
            schedulerRef.current?.edited();
            // The preview is armed here and NOT on a title change: the title is rendered by
            // the reader outside `.body`, from its own column, so retyping it changes
            // nothing in the rendered document and a render per keystroke there would be
            // pure cost.
            previewRef.current?.edited();
            dispatch({ type: "edited" });
          }),
          EditorView.domEventHandlers({
            // Also on blur, so a tab closed two seconds after the last keystroke does not
            // take those two seconds with it.
            blur: () => {
              schedulerRef.current?.flush();
              previewRef.current?.flush();
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

  /**
   * What the picker shows: the document's own `status:` when it declares one, and otherwise the
   * status a publish would land on if nobody chose anything.
   *
   * The fallback is **displayed and not written**. Writing it on mount would mark every page
   * dirty the moment it was opened and autosave a line nobody typed; showing it is honest,
   * because it is exactly where `defaultPublishStatus` will put the page.
   */
  const effectiveStatus = declaredStatus ?? page.defaultStatus;

  const notice =
    publishing.outcome?.type === "published"
      ? dormantNotice(publishing.outcome.dormant, publishing.outcome.status)
      : null;

  const loadTheirs = () => {
    const view = viewRef.current;
    if (!view || !theirs) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: theirs.markdown },
      annotations: FromServer.of(true),
    });
    setTitle(theirs.title);
    titleRef.current = theirs.title;
    // The `FromServer` annotation makes the update listener ignore this transaction, which
    // is right for saving — we must not write their text back at them — and wrong for the
    // preview, which would otherwise keep showing the document that was just replaced.
    previewRef.current?.edited();
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

  /**
   * Waits until this client has nothing unsent, or reports that it cannot get there.
   *
   * Publish publishes **the draft row**, not what is on screen, so the unsent edits have to
   * land first — otherwise clicking Publish two seconds after a keystroke publishes the text
   * from before it, and the editor is told the page went out with a paragraph it did not
   * contain.
   *
   * It goes through the scheduler's own `flush` rather than calling `save` directly, because
   * clicking this button blurs the editor and the blur handler already starts a save: a
   * second, direct save would be a PUT overlapping the first, carrying a `seen` the first is
   * about to invalidate — a 409 raised by the user against themselves. `flush` is the one
   * entry point that knows about the in-flight rule.
   *
   * The state is read from `stateRef` between waits, never from the closure: `dispatch` is
   * asynchronous, so the render that owns this handler cannot see the outcome of a save it
   * just triggered.
   */
  const settleSaves = useCallback(async (): Promise<boolean> => {
    // ~4 seconds, which is twice the autosave interval. A bound rather than a deadline: if a
    // save is genuinely stuck, saying so beats publishing text nobody has seen confirmed.
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = stateRef.current;
      // An unanswered conflict or a failure is a question for the person, not something to
      // publish through. Their own banner already says what it is.
      if (current.conflict !== null || current.status.kind === "error") return false;
      if (current.status.kind === "clean" && schedulerRef.current?.isDirty() !== true) {
        return true;
      }
      schedulerRef.current?.flush();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }, []);

  /**
   * Selects one line of the document and puts the cursor in it — how a refusal that names a
   * frontmatter key becomes something a person can see.
   *
   * This is the plan's question answered as a control rather than as a sentence. Frontmatter has
   * no per-key input, so an error can only be *placed* against text; a button that scrolls the
   * offending line into view and selects it is the nearest thing to an underlined field a single
   * textarea has. `placeErrors` decides which line, from the document as it stands.
   *
   * Clamped, because the document may have been edited since the refusal came back — the author
   * is invited to fix it, after all — and `doc.line()` throws on a line that no longer exists.
   * A selection change is not a document change, so the update listener ignores it and nothing
   * is marked dirty.
   */
  const goToLine = (line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      scrollIntoView: true,
    });
    view.focus();
  };

  /**
   * The status picker: it **writes the document's `status:`** rather than sending a status of
   * its own with the publish request.
   *
   * The argument is at `setFrontmatterStatus` and it is short: `publishPage`'s precedence is
   * `options.status ?? frontmatter.status ?? default`, so a picker with its own value would
   * outrank the author's own line and could commit a version whose stored frontmatter and whose
   * page status disagree — the §6.3 divergence the frontmatter wiring exists to close.
   *
   * The edit is a **minimal** replacement, not a whole-document dispatch: CodeMirror maps the
   * cursor, the selection and the scroll position through a change, and replacing everything
   * would throw the caret to the end of a document somebody is typing in.
   */
  const chooseStatus = (next: string) => {
    const view = viewRef.current;
    if (!view) return;
    const before = view.state.doc.toString();
    const change = minimalReplacement(before, setFrontmatterStatus(before, next));
    // Already says exactly this. Nothing to write, nothing to save, nothing to undo.
    if (change === null) return;
    // No `FromServer` annotation: this IS an edit, and the update listener has to treat it as
    // one — autosave it, re-render the preview, and re-read the select's own value from it.
    view.dispatch({ changes: change });
  };

  const publish = async () => {
    if (publishing.pending) return;
    setPublishing({ pending: true, outcome: null });

    const failed = (message: string) =>
      setPublishing({ pending: false, outcome: { type: "failed", message } });

    if (!(await settleSaves())) {
      failed(
        "Not published — your latest changes are not saved yet. Deal with the notice " +
          "above first, then publish.",
      );
      return;
    }

    let response: Response;
    try {
      response = await fetch(`/api/pages/${page.id}/publish`, { method: "POST" });
    } catch {
      failed("Not published — the browser could not reach the server.");
      return;
    }

    const body = await response.json().catch(() => null);
    // The document as the server saw it: `settleSaves` has just confirmed there is nothing
    // unsent, so what is in the view is what was published — and it is what every refusal is
    // placed against. Read from the view rather than from React state, as every other read in
    // this component is.
    const markdown = viewRef.current?.state.doc.toString() ?? page.markdown;
    const outcome = publishOutcome({ status: response.status, body, markdown });
    setPublishing({ pending: false, outcome });

    if (outcome.type !== "published") return;

    // **A publish with something to say does not navigate.**
    //
    // Everything else does, exactly as before: the draft row is gone, both clocks are stopped
    // so a pending autosave cannot fire into it and raise the "this draft is gone" banner over
    // a page on its way out, and the reader URL is the endpoint's own `pageHref`.
    //
    // A dormant cascade is the exception, because the notice is the entire point of this task
    // and a message rendered on a component that is being replaced is a message nobody reads.
    // The clocks are deliberately left running in that branch: `settleSaves` proved there is
    // nothing pending, so nothing fires on its own, and if the author goes back to typing they
    // are starting a new revision — for which the vanished-draft banner is the accurate answer
    // and offers the right action.
    if (outcome.dormant.length > 0) return;

    schedulerRef.current?.stop();
    previewRef.current?.stop();
    router.push(outcome.href as Parameters<typeof router.push>[0]);
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
        <div className="ed-actions">
          <span
            className={`ed-status ed-status-${state.status.kind}`}
            role="status"
            aria-live="polite"
          >
            {saveStatusLabel(state, hydrated ? formatTime : null)}
          </span>
          {/*
            The status picker. Its options are `publishDestinations` — the statuses reachable
            from the one this page is in — computed on the server so this component holds no
            copy of the vocabulary.

            It is labelled "Publish as" rather than "Status" because that is what it does: it
            does not change the page's status, it changes the `status:` line the next publish
            will read. Choosing here and never pressing Publish leaves the page exactly where
            it was, with a draft that says where it is going.
          */}
          <label className="ed-pick" htmlFor="ed-status-pick">
            <span className="ed-pick-label">Publish as</span>
            <select
              id="ed-status-pick"
              className="ed-pick-select"
              value={effectiveStatus}
              disabled={page.statusOptions.length === 0}
              onChange={(event) => chooseStatus(event.target.value)}
            >
              {/*
                A declared status the vocabulary cannot reach from here — `status: banana`, or a
                `SUPERSEDED` on a page that has never been accepted — is shown and disabled
                rather than silently replaced by something else. A control that displays a value
                other than the text underneath it is the worse failure, and publish refuses this
                one with a sentence that names the line.
              */}
              {page.statusOptions.includes(effectiveStatus) ? null : (
                <option value={effectiveStatus} disabled>
                  {effectiveStatus} — not available from {page.status}
                </option>
              )}
              {page.statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ed-publish"
            onClick={() => void publish()}
            disabled={publishing.pending}
          >
            {publishing.pending ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>

      {/*
        A publish outcome gets its own alert rather than the save indicator's slot. The two say
        different things — "your work is not stored" versus "your work is stored and did not go
        out" — and the second must not overwrite the first.
      */}
      {publishing.outcome?.type === "failed" ? (
        <p className="ed-publish-error" role="alert">
          {publishing.outcome.message}
        </p>
      ) : null}

      {/*
        Every refusal, each against something the author can see.

        The plan left "which of `error` and `errors` to render, and where" to this task. All of
        them: they were declared in one pass and fixing them one publish attempt at a time is a
        bad loop. `placeErrors` decided where each belongs, from the document as it stands — a
        line in the frontmatter, the title input, or the document as a whole — and the button is
        what makes "against the offending key" real in a surface with one textarea.
      */}
      {publishing.outcome?.type === "refused" ? (
        <div className="ed-publish-error" role="alert">
          <p className="ed-publish-lead">
            Not published. {publishing.outcome.errors.length === 1
              ? "One thing needs fixing:"
              : `${publishing.outcome.errors.length} things need fixing:`}
          </p>
          <ul className="ed-problems">
            {publishing.outcome.errors.map((problem, index) => (
              // Indexed, because the same code can legitimately appear twice — two entries of
              // one `supersedes:` list, each naming a page that does not exist.
              <li key={`${problem.code}-${problem.key ?? ""}-${index}`}>
                {problem.placement.kind === "line" ? (
                  <button
                    type="button"
                    className="ed-problem-where"
                    onClick={() => goToLine(problem.placement.kind === "line"
                      ? problem.placement.line
                      : 1)}
                  >
                    line {problem.placement.line} · {problem.placement.key}:
                  </button>
                ) : problem.placement.kind === "key" ? (
                  <span className="ed-problem-where ed-problem-plain">
                    {problem.placement.key}:
                  </span>
                ) : problem.placement.kind === "title" ? (
                  <span className="ed-problem-where ed-problem-plain">title</span>
                ) : null}{" "}
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The dormant cascade. A publish that recorded a `supersedes:` and retired nothing is
        correct and looks exactly like a bug, which is the whole reason this notice exists.

        It is not an error and does not wear the error's colour: the page went out. It is also
        the one success this surface does not navigate away from — see `publish`.
      */}
      {notice ? (
        <div className="ed-dormant" role="status">
          <p className="ed-dormant-lead">{notice.lead}</p>
          <ul className="ed-problems">
            {notice.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="ed-dormant-go">
            <a href={publishing.outcome?.type === "published" ? publishing.outcome.href : "#"}>
              Open the published page
            </a>
          </p>
        </div>
      ) : null}

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

      <div className="ed-split">
        <section className="ed-pane">
          <div className="ed-panehead">
            <label className="ed-label" htmlFor="ed-doc">
              Markdown
            </label>
          </div>
          {/*
            CodeMirror owns everything inside this element. React must never render children
            into it — the two would fight over the same DOM nodes on the first re-render.
          */}
          <div className="ed-surface" id="ed-doc" ref={hostRef} />
        </section>

        <section className="ed-pane" aria-label="Preview">
          <div className="ed-panehead">
            <span className="ed-label">Preview</span>
            {/*
              Only an error is announced. "Rendering…" every two seconds beside a save
              indicator that is already saying "Saving…" on the same tick is noise, and it is
              the one message nobody needs read aloud.
            */}
            <span className="ed-preview-state" role="status" aria-live="polite">
              {preview.error}
            </span>
            {preview.error === null && preview.pending ? (
              <span className="ed-preview-state" aria-hidden="true">
                Rendering&hellip;
              </span>
            ) : null}
          </div>
          <div className={`ed-preview${preview.error ? " ed-preview-stale" : ""}`}>
            {preview.html === "" && !preview.pending && preview.error === null ? (
              <p className="ed-preview-empty">Nothing to preview yet.</p>
            ) : (
              /*
                Rendered with `dangerouslySetInnerHTML` for exactly the reason the reader
                route is, and safe for exactly the same one and no other: `renderMarkdown`
                sanitises, and `/api/preview` calls it rather than a variant of it. If that
                route ever stops going through the shared pipeline, this line becomes an XSS
                sink reflected off the caller's own body.

                `.body` is the reader's own class, from `doc.css`, imported by the (editor)
                layout — never by this route — so the preview inherits the reader's
                typography instead of an approximation of it.

                `DocBody` and not a bare `div`, for the same reason: it is the component that
                owns `.body` and hydrates its ```mermaid fences, so an author writing a diagram
                sees whether it parses in the pane rather than after publishing. It keys its
                hydration on the html string, which is what makes it safe to hand a new document
                every two seconds. Mermaid stays a dynamic import here too — a preview with no
                fence never loads it.
              */
              <DocBody html={preview.html} />
            )}
          </div>
        </section>
      </div>

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
