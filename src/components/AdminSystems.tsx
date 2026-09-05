"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminSystemRow, BlockingPage, SystemFieldError } from "@/lib/systems/admin";
import { SystemRepo } from "./SystemRepo";

/**
 * `/admin/systems` — the catalogue an admin edits. Spec §7, Phase 7 Task 5.
 *
 * ## Nothing here decides anything
 *
 * Every rule is on the server and every sentence comes back from it: whether a key is legal
 * (`validateSystemKey`), whether a repository URL may be stored (`repoLinkOf`, the write half of
 * Task 3's two-ended credential fix), whether a delete is refused and what to do instead
 * (`PageSystem.systemId`'s `Restrict`, and `deleteSystem`'s own sentence). This component posts,
 * renders what it is told, and calls `router.refresh()` — `ConfirmReviewButton`'s shape, for its
 * reason: the list it is looking at is server-rendered, so re-deriving a row here would be a
 * second copy of state nobody can keep in step.
 *
 * A client-side copy of any of those rules would be the trap Phase 4 Task 3 measured from the
 * other side, where a TypeScript filter after the query left the SQL clause deletable with 24
 * tests green.
 *
 * ## The reference count is on every row, before anything is clicked
 *
 * That is Task 1's requirement in one line: `Restrict` makes a delete refusable, so *"the
 * reference count next to every system, so a delete that will be refused is predicted and not
 * discovered"*. The number is `PageSystem` rows and counts soft-deleted and unpublished pages,
 * because those block the foreign key too — the row says so where it differs from `/systems`.
 *
 * **Showing the number is not the same act as showing the titles.** The count needs no audit; the
 * list of blocking pages is a cross-boundary read of titles and paths out of spaces the admin may
 * not belong to, and it is fetched behind its own control, from its own endpoint, which writes a
 * `space.access` row. So the button says what it will do.
 *
 * ## Why the repository field is empty on an edit
 *
 * The one input this form does not prefill. Task 3 withholds a stored URL that embeds userinfo
 * from *everyone*, including a super admin, because printing it is what puts it into a rendered
 * page and a screenshot — and an edit form is a rendered page. So an edit is a **patch**: leave the
 * field empty and the column is untouched; type a URL and it replaces; tick the box to clear it.
 * The placeholder says which of the three states the column is in without quoting any of it.
 *
 * ## Overflow
 *
 * Every value here was typed by a person, painted outside `.body`. The row is a wrapping flex
 * container with `min-width: 0`, and **no element carrying admin-typed text is `flex: none`** —
 * Task 3's ninth shape was exactly that, 515px from a `.sys-team` that was not allowed to shrink.
 * `flex: none` stays reserved for values the database bounds: the `SystemKind` chip and the count.
 */

/** `key` for the create form's feedback. Not a cuid, so it cannot collide with a system id. */
const NEW = "new";

type Feedback = {
  /** Per-input sentences from the server, rendered against the field each one names. */
  errors?: SystemFieldError[];
  /** A whole-form sentence: a refused delete, a rename's consequence, a dead network. */
  message?: string;
  /** The refused delete's alternative — offered only when the system is not already sunsetting. */
  offerSunset?: boolean;
};

type Blocking = { pages: BlockingPage[]; truncated: boolean };

export function AdminSystems({ systems }: { systems: AdminSystemRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [blocking, setBlocking] = useState<Record<string, Blocking>>({});

  const setFor = (id: string, value: Feedback) =>
    setFeedback((all) => ({ ...all, [id]: value }));

  /**
   * One request, one place the failure shapes are handled.
   *
   * The three outcomes a caller cares about are: it worked (the parsed body), the server had
   * something to say about a field (422, rendered beside the input), or it refused as a whole (any
   * other status, plus the browser failing to reach the server at all — which is a sentence and
   * not a silent no-op, because a button that does nothing is indistinguishable from a button that
   * did something).
   */
  const send = async (
    id: string,
    url: string,
    init: RequestInit,
  ): Promise<Record<string, unknown> | null> => {
    setPending(id);
    setFor(id, {});

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      setPending(null);
      setFor(id, { message: "Nothing was saved — the browser could not reach the server." });
      return null;
    }

    const body: unknown = await response.json().catch(() => null);
    const parsed = (body ?? {}) as Record<string, unknown>;
    setPending(null);

    if (response.ok) return parsed;

    if (response.status === 422 && Array.isArray(parsed.errors)) {
      setFor(id, { errors: parsed.errors as SystemFieldError[] });
      return null;
    }

    setFor(id, {
      // The server's own sentence, verbatim — see the module docstring. The fallback is for a
      // status with no body at all, not for a case the endpoints produce.
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : `Nothing was saved — the server refused it (${response.status}).`,
      // `409` is the refused delete, and `isActive` is what decides whether "mark it sunsetting"
      // is the thing to offer or a repeat of what has already been done.
      offerSunset: response.status === 409 && parsed.isActive === true,
    });
    return null;
  };

  const create = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const created = await send(NEW, "/api/admin/systems", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: text(data, "key"),
        name: text(data, "name"),
        kind: text(data, "kind"),
        ownerTeam: text(data, "ownerTeam"),
        description: text(data, "description"),
        repoUrl: text(data, "repoUrl"),
      }),
    });
    if (created === null) return;
    form.reset();
    router.refresh();
  };

  const save = async (system: AdminSystemRow, form: HTMLFormElement) => {
    const data = new FormData(form);
    /*
     * A patch. Five fields are prefilled and always sent; `repoUrl` is sent only when the admin
     * typed one or asked for it to be cleared — see the component docstring for why it cannot be
     * prefilled.
     */
    const repoUrl = text(data, "repoUrl");
    const clearRepo = data.get("clearRepo") !== null;
    const saved = await send(system.id, `/api/admin/systems/${system.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: text(data, "key"),
        name: text(data, "name"),
        kind: text(data, "kind"),
        ownerTeam: text(data, "ownerTeam"),
        description: text(data, "description"),
        isActive: data.get("isActive") !== null,
        ...(repoUrl !== "" ? { repoUrl } : clearRepo ? { repoUrl: "" } : {}),
      }),
    });
    if (saved === null) return;

    setEditing(null);
    // A rename's consequence, stated with the number it applies to, at the moment it happens. The
    // count was on the row before the form was opened; this is the same fact after the fact,
    // because the pages it names cannot be republished until somebody edits their `systems:` line.
    if (typeof saved.renamedFrom === "string") {
      const references = typeof saved.references === "number" ? saved.references : 0;
      setFor(
        system.id,
        references === 0
          ? { message: `Renamed from "${saved.renamedFrom}". No page names it, so nothing else changes.` }
          : {
              message:
                `Renamed from "${saved.renamedFrom}". ${references === 1 ? "1 page" : `${references} pages`} ` +
                `still say "${saved.renamedFrom}" in their published frontmatter, and republishing ` +
                "one will be refused until that line is changed to the new key. The rename is in " +
                "the audit log either way.",
            },
      );
    }
    router.refresh();
  };

  const remove = async (system: AdminSystemRow) => {
    const done = await send(system.id, `/api/admin/systems/${system.id}`, { method: "DELETE" });
    if (done === null) return;
    router.refresh();
  };

  /** The refused delete's alternative, in the place the refusal appeared. Task 1 asked for this. */
  const sunset = async (system: AdminSystemRow) => {
    const done = await send(system.id, `/api/admin/systems/${system.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    if (done === null) return;
    router.refresh();
  };

  const showBlocking = async (system: AdminSystemRow) => {
    const listed = await send(system.id, `/api/admin/systems/${system.id}/pages`, {
      method: "GET",
    });
    if (listed === null) return;
    setBlocking((all) => ({
      ...all,
      [system.id]: {
        pages: (listed.pages ?? []) as BlockingPage[],
        truncated: listed.truncated === true,
      },
    }));
  };

  return (
    <>
      <details className="adm-new">
        <summary className="adm-new-toggle">Add a system</summary>
        <form
          className="adm-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create(event.currentTarget);
          }}
        >
          <Fields errors={feedback[NEW]?.errors} />
          <p className="adm-actions">
            <button className="adm-btn adm-primary" type="submit" disabled={pending === NEW}>
              {pending === NEW ? "Adding…" : "Add system"}
            </button>
          </p>
          <Message feedback={feedback[NEW]} />
        </form>
      </details>

      {systems.length === 0 ? (
        <p className="sys-empty">
          The catalogue is empty. Until a system exists here, no page can declare one — publish
          refuses a <code className="sys-code">systems:</code> key that names nothing.
        </p>
      ) : (
        <ul className="sys-list">
          {systems.map((system) => (
            <li className="sys-row" key={system.id}>
              <p className="sys-head">
                <span className="sys-kind">{system.kind}</span>
                <span className="sys-name">{system.name}</span>
                {system.isActive ? null : <span className="sys-sunset">Sunsetting</span>}
                {/* `flex: none` is safe here and nowhere else on the row: a count is a number
                    the database bounds, not a string somebody typed. */}
                <span className="adm-refs">
                  {system.references === 1 ? "1 page" : `${system.references} pages`}
                </span>
              </p>

              {system.description === null ? null : (
                <p className="sys-desc">{system.description}</p>
              )}

              <p className="sys-meta">
                <code className="sys-key">{system.key}</code>
                {system.ownerTeam === null ? (
                  <span className="sys-team sys-none">No owning team</span>
                ) : (
                  <span className="sys-team">{system.ownerTeam}</span>
                )}
                <SystemRepo repo={system.repo} />
              </p>

              <p className="adm-actions">
                <button
                  className="adm-btn"
                  type="button"
                  onClick={() => setEditing(editing === system.id ? null : system.id)}
                >
                  {editing === system.id ? "Cancel" : "Edit"}
                </button>
                <button
                  className="adm-btn"
                  type="button"
                  disabled={pending === system.id}
                  onClick={() => void remove(system)}
                >
                  Delete
                </button>
                {system.references === 0 ? null : (
                  <button
                    className="adm-btn"
                    type="button"
                    disabled={pending === system.id}
                    /* The one control on this page that reads across a space boundary, so it says
                       so: the count above needs no audit and this list writes one. */
                    title="Lists titles and paths from every space, and records that you did"
                    onClick={() => void showBlocking(system)}
                  >
                    Which pages?
                  </button>
                )}
              </p>

              <Message feedback={feedback[system.id]} />
              {feedback[system.id]?.offerSunset ? (
                <p className="adm-actions">
                  <button
                    className="adm-btn adm-primary"
                    type="button"
                    disabled={pending === system.id}
                    onClick={() => void sunset(system)}
                  >
                    Mark it sunsetting instead
                  </button>
                </p>
              ) : null}

              {blocking[system.id] === undefined ? null : (
                <BlockingList listed={blocking[system.id]!} />
              )}

              {editing === system.id ? (
                <form
                  className="adm-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(system, event.currentTarget);
                  }}
                >
                  <Fields system={system} errors={feedback[system.id]?.errors} />
                  {/* §7's "active or sunsetting", and the state Task 1 named as the reason
                      `Restrict` is operable rather than merely strict. Only on an edit: a system
                      being added is active, which is what the column's default says. */}
                  <label className="adm-check">
                    <input type="checkbox" name="isActive" defaultChecked={system.isActive} />
                    Active — untick to mark it sunsetting
                  </label>
                  <p className="adm-actions">
                    <button
                      className="adm-btn adm-primary"
                      type="submit"
                      disabled={pending === system.id}
                    >
                      {pending === system.id ? "Saving…" : "Save"}
                    </button>
                  </p>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** `FormData.get` returns `File | string | null`; every input here is a text input. */
function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

const KINDS = ["MOBILE_APP", "DEVICE_APP", "SERVICE", "LIBRARY"] as const;

/**
 * The six inputs, shared by the create form and every edit form so the two cannot drift apart.
 *
 * `system === undefined` is the create case: no prefill, and no `isActive` control — a new system
 * is active, which is what the column's default says and what §7 means by a catalogue entry.
 *
 * The `kind` options are spelled out rather than derived from Prisma's enum, because this is a
 * client component and importing `@prisma/client` for four strings would pull the generated client
 * into the browser bundle. The endpoint validates against the real enum with `z.enum(SystemKind)`,
 * so a value this list forgets is refused rather than stored — the list can be wrong in the safe
 * direction only.
 */
function Fields({
  system,
  errors,
}: {
  system?: AdminSystemRow;
  errors?: SystemFieldError[];
}) {
  const error = (field: string) => errors?.find((each) => each.field === field);
  return (
    <>
      <Field label="Key" field="key" error={error("key")}>
        <input
          className="adm-input"
          name="key"
          defaultValue={system?.key ?? ""}
          placeholder="order-hub"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Field label="Name" field="name" error={error("name")}>
        <input
          className="adm-input"
          name="name"
          defaultValue={system?.name ?? ""}
          placeholder="Order hub"
          autoComplete="off"
        />
      </Field>

      <Field label="Kind" field="kind" error={error("kind")}>
        <select className="adm-input" name="kind" defaultValue={system?.kind ?? "SERVICE"}>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Owning team" field="ownerTeam" error={error("ownerTeam")}>
        <input
          className="adm-input"
          name="ownerTeam"
          defaultValue={system?.ownerTeam ?? ""}
          autoComplete="off"
        />
      </Field>

      <Field label="Description" field="description" error={error("description")}>
        <textarea
          className="adm-input adm-area"
          name="description"
          rows={2}
          defaultValue={system?.description ?? ""}
        />
      </Field>

      <Field label="Repository URL" field="repoUrl" error={error("repoUrl")}>
        <input
          className="adm-input"
          name="repoUrl"
          /*
           * Never prefilled, even on an edit, and even for a super admin. The stored value may
           * embed a token — `git remote -v` on this machine prints
           * `https://oauth2:<token>@gitlab…` — and Task 3's half of the fix is that such a URL is
           * not printed at all. The placeholder describes the column's state without quoting it.
           */
          defaultValue=""
          placeholder={repoPlaceholder(system)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      {/* Outside `Field`, because `Field` is itself a `<label>` and a label inside a label is not
          valid HTML — the checkbox needs its own. */}
      {system === undefined ? null : (
        <label className="adm-check">
          <input type="checkbox" name="clearRepo" />
          Remove the stored repository URL
        </label>
      )}
    </>
  );
}

function repoPlaceholder(system?: AdminSystemRow): string {
  if (system === undefined) return "https://gitlab.example.com/group/repo.git";
  switch (system.repo.kind) {
    case "absent":
      return "https://gitlab.example.com/group/repo.git — nothing stored";
    case "link":
      return "Leave empty to keep the stored URL";
    case "withheld":
      // Deliberately says nothing about the URL itself, not even its host: the reason is enough
      // to act on, and `SystemRepo` above has already rendered the full sentence.
      return "Leave empty to keep the stored URL — which is not being shown, see above";
  }
}

function Field({
  label,
  field,
  error,
  children,
}: {
  label: string;
  field: string;
  error?: SystemFieldError;
  children: React.ReactNode;
}) {
  return (
    <label className="adm-field">
      <span className="adm-label">{label}</span>
      {children}
      {error === undefined ? null : (
        <span className="adm-error" role="alert" data-field={field}>
          {error.message}
        </span>
      )}
    </label>
  );
}

/** The whole-form sentence: a refused delete, a rename's consequence, or an unreachable server. */
function Message({ feedback }: { feedback?: Feedback }) {
  if (feedback?.message === undefined) return null;
  return (
    <p className="adm-message" role="alert">
      {feedback.message}
    </p>
  );
}

/**
 * The pages blocking a delete.
 *
 * Titles and paths from every space, which is why fetching this wrote an audit row. Not links: a
 * page in a space the admin is not a member of is readable to them (`isSuperAdmin` grants
 * `MANAGE_SPACE`, §8) but following the link would be a *second* audited read, and what an admin
 * needs here is to know which documents to talk to somebody about.
 *
 * A soft-deleted page is flagged and not hidden: it still holds its facet row and still blocks the
 * delete, so hiding it would leave a refusal with nothing visible causing it.
 */
function BlockingList({ listed }: { listed: Blocking }) {
  return (
    <ul className="adm-pages">
      {listed.pages.map((page) => (
        <li className="adm-page" key={page.pageId}>
          <span className="adm-page-title">{page.title}</span>
          <span className="sys-space">{page.spaceName}</span>
          {page.deleted ? <span className="adm-deleted">deleted</span> : null}
          <code className="sys-path">
            {page.spaceKey}/{page.path}
          </code>
        </li>
      ))}
      {listed.truncated ? (
        <li className="adm-page adm-more">
          More pages name this system than are listed here.
        </li>
      ) : null}
    </ul>
  );
}
