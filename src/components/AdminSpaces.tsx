"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminSpaceRow, SpaceFieldError, SpaceMember } from "@/lib/spaces/admin";

/**
 * `/admin/spaces` — the spaces an admin creates, edits and staffs. Spec §11, Phase 7 Task 6.
 *
 * ## Nothing here decides anything
 *
 * `AdminSystems`'s rule, and on this surface it matters more: whether a key is legal
 * (`validateSpaceKey`, including the reserved-route list), whether it may still be changed (the
 * page count), whether a person exists to be added, and what removing the last admin leaves behind
 * are all server answers. This component posts, renders what it is told, and calls
 * `router.refresh()`.
 *
 * ## What it shows before anything is clicked, and why those three things
 *
 * A row carries **visibility, the member count and the page count**, because together they are the
 * whole answer to "who can read this and how much is in it" — the prediction half of every change
 * this page can make. Two consequences are stated on the row rather than discovered:
 *
 * - a `MEMBERS` space with **no members** is readable by super admins alone, which is the state
 *   every newly created space is in;
 * - a space with pages **cannot be rekeyed**, so the key input is disabled with the reason on it
 *   rather than accepting a value the server will refuse.
 *
 * The second is a *duplicate of a server rule in the client*, which this project normally refuses,
 * so it is worth being explicit: the disabled input is an affordance, not the rule. The rule is in
 * `updateSpace` and the form still sends nothing the server does not re-decide —
 * `tests/integration/spaces-admin.test.ts` drives a rename against a space with pages directly and
 * gets the refusal, so removing this attribute changes what an admin sees and not what happens.
 *
 * ## Showing the count is not the same act as showing the people
 *
 * The member count needs no audit. The member *list* is a cross-boundary read of names and email
 * addresses out of a space the admin may not belong to, so it is fetched behind its own control,
 * from its own endpoint, which writes a `space.access` row — and the button says so.
 *
 * ## Overflow
 *
 * Every value here was typed by a person or by an identity provider, painted outside `.body`. The
 * row is a wrapping flex container with `min-width: 0`, and **no element carrying typed text is
 * `flex: none`** — Task 3's ninth shape was exactly that. `flex: none` stays for the visibility
 * chip and the two counts.
 */

/** `key` for the create form's feedback. Not a cuid, so it cannot collide with a space id. */
const NEW = "new";

type Feedback = {
  /** Per-input sentences from the server, rendered against the field each one names. */
  errors?: SpaceFieldError[];
  /** A whole-form sentence: a refused rename, a widened space, an offboarded last admin. */
  message?: string;
};

type Members = { list: SpaceMember[]; truncated: boolean };

const ROLES = ["VIEWER", "EDITOR", "ADMIN"] as const;
const VISIBILITIES = ["MEMBERS", "ALL_STAFF"] as const;

export function AdminSpaces({ spaces }: { spaces: AdminSpaceRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [members, setMembers] = useState<Record<string, Members>>({});

  const setFor = (id: string, value: Feedback) => setFeedback((all) => ({ ...all, [id]: value }));

  /**
   * One request, one place the failure shapes are handled — `AdminSystems`'s `send`, including the
   * lesson its e2e run paid for.
   *
   * `clears` is `false` for the member listing, and that is not a nicety: **a refusal must survive
   * the button it invites.** "Members" is the control an admin presses after being told a space
   * has three of them, and clearing the row would delete whatever sentence they were acting on at
   * the moment they acted on it. The four mutations still clear.
   */
  const send = async (
    id: string,
    url: string,
    init: RequestInit,
    clears = true,
  ): Promise<Record<string, unknown> | null> => {
    setPending(id);
    if (clears) setFor(id, {});

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
      setFor(id, { errors: parsed.errors as SpaceFieldError[] });
      return null;
    }

    setFor(id, {
      // The server's own sentence, verbatim. The fallback is for a status with no body at all.
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : `Nothing was saved — the server refused it (${response.status}).`,
    });
    return null;
  };

  const create = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const created = await send(NEW, "/api/admin/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: text(data, "key"),
        name: text(data, "name"),
        initials: text(data, "initials"),
        description: text(data, "description"),
        visibility: text(data, "visibility"),
      }),
    });
    if (created === null) return;
    form.reset();
    router.refresh();
  };

  const save = async (space: AdminSpaceRow, form: HTMLFormElement) => {
    const data = new FormData(form);
    // A patch. `key` is sent only when the space is still empty — see the component docstring:
    // the disabled input is an affordance and `updateSpace` is the rule.
    const key = text(data, "key");
    const saved = await send(space.id, `/api/admin/spaces/${space.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: text(data, "name"),
        initials: text(data, "initials"),
        description: text(data, "description"),
        visibility: text(data, "visibility"),
        ...(space.pages === 0 ? { key } : {}),
      }),
    });
    if (saved === null) return;

    setEditing(null);
    // The two consequences worth stating with the number they apply to, at the moment they happen.
    const said: string[] = [];
    if (typeof saved.renamedFrom === "string") {
      said.push(`Rekeyed from "${saved.renamedFrom}". The space was empty, so no URL changed.`);
    }
    if (saved.visibilityWas === "MEMBERS") {
      const pages = typeof saved.pages === "number" ? saved.pages : 0;
      said.push(
        `This space is now readable by everyone who can sign in — ${
          pages === 1 ? "1 page" : `${pages} pages`
        } that were members-only a moment ago. Reads of it by a super admin who is not a member ` +
          "also stop being recorded from now on, because that trail only covers members-only " +
          "spaces.",
      );
    }
    if (saved.visibilityWas === "ALL_STAFF") {
      said.push(
        "This space is now members-only. Anyone who was reading it without a membership has just " +
          "lost access.",
      );
    }
    if (said.length > 0) setFor(space.id, { message: said.join(" ") });
    router.refresh();
  };

  const addMember = async (space: AdminSpaceRow, form: HTMLFormElement) => {
    const data = new FormData(form);
    const added = await send(space.id, `/api/admin/spaces/${space.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: text(data, "email"), role: text(data, "role") }),
    });
    if (added === null) return;
    form.reset();
    await showMembers(space, false);
    router.refresh();
  };

  const setRole = async (space: AdminSpaceRow, userId: string, role: string) => {
    const changed = await send(
      space.id,
      `/api/admin/spaces/${space.id}/members/${userId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      },
    );
    if (changed === null) return;
    if (changed.admins === 0) setFor(space.id, { message: NO_ADMINS });
    await showMembers(space, false);
    router.refresh();
  };

  const remove = async (space: AdminSpaceRow, userId: string) => {
    const removed = await send(
      space.id,
      `/api/admin/spaces/${space.id}/members/${userId}`,
      { method: "DELETE" },
    );
    if (removed === null) return;
    if (removed.admins === 0) setFor(space.id, { message: NO_ADMINS });
    await showMembers(space, false);
    router.refresh();
  };

  const showMembers = async (space: AdminSpaceRow, clears = false) => {
    const listed = await send(
      space.id,
      `/api/admin/spaces/${space.id}/members`,
      { method: "GET" },
      clears,
    );
    if (listed === null) return;
    setMembers((all) => ({
      ...all,
      [space.id]: {
        list: (listed.members ?? []) as SpaceMember[],
        truncated: listed.truncated === true,
      },
    }));
  };

  return (
    <>
      <details className="adm-new">
        <summary className="adm-new-toggle">Add a space</summary>
        <form
          className="adm-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create(event.currentTarget);
          }}
        >
          <Fields errors={feedback[NEW]?.errors} />
          <p className="adm-note">
            A new space has no members. While it is members-only that means nobody but a super
            admin can open it — add the people who should have it below, once it exists.
          </p>
          <p className="adm-actions">
            <button className="adm-btn adm-primary" type="submit" disabled={pending === NEW}>
              {pending === NEW ? "Adding…" : "Add space"}
            </button>
          </p>
          <Message feedback={feedback[NEW]} />
        </form>
      </details>

      <ul className="sys-list">
        {spaces.map((space) => (
          <li className="sys-row" key={space.id}>
            <p className="sys-head">
              {/* `flex: none` is safe on these three and nowhere else on the row: an enum the
                  database bounds, and two integers. */}
              <span className="sys-kind">{space.visibility}</span>
              <span className="sys-name">{space.name}</span>
              <span className="adm-refs">
                {space.members === 1 ? "1 member" : `${space.members} members`}
              </span>
              <span className="adm-refs">
                {space.pages === 1 ? "1 page" : `${space.pages} pages`}
              </span>
            </p>

            {space.description === null ? null : (
              <p className="sys-desc">{space.description}</p>
            )}

            <p className="sys-meta">
              <code className="sys-key">{space.key}</code>
              <span className="sys-team">{space.initials}</span>
            </p>

            {space.visibility === "MEMBERS" && space.members === 0 ? (
              <p className="adm-note">
                No one is a member, and it is members-only — so nobody but a super admin can open
                this space or anything in it.
              </p>
            ) : null}

            <p className="adm-actions">
              <button
                className="adm-btn"
                type="button"
                onClick={() => setEditing(editing === space.id ? null : space.id)}
              >
                {editing === space.id ? "Cancel" : "Edit"}
              </button>
              <button
                className="adm-btn"
                type="button"
                disabled={pending === space.id}
                /* The one control on this page that reads across a space boundary, so it says so:
                   the count above needs no audit and this list writes one. */
                title="Lists names and email addresses, and records that you did"
                onClick={() => void showMembers(space, true)}
              >
                Members
              </button>
            </p>

            <Message feedback={feedback[space.id]} />

            {members[space.id] === undefined ? null : (
              <MemberList
                listed={members[space.id]!}
                busy={pending === space.id}
                onRole={(userId, role) => void setRole(space, userId, role)}
                onRemove={(userId) => void remove(space, userId)}
                onAdd={(form) => void addMember(space, form)}
                errors={feedback[space.id]?.errors}
              />
            )}

            {editing === space.id ? (
              <form
                className="adm-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(space, event.currentTarget);
                }}
              >
                <Fields space={space} errors={feedback[space.id]?.errors} />
                <p className="adm-actions">
                  <button
                    className="adm-btn adm-primary"
                    type="submit"
                    disabled={pending === space.id}
                  >
                    {pending === space.id ? "Saving…" : "Save"}
                  </button>
                </p>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What is left when the last `ADMIN` goes.
 *
 * Not a refusal: `can()` short-circuits on `isSuperAdmin`, so the space stays administrable and
 * refusing would make the last admin of a space unoffboardable. It is still worth saying, because
 * the person who reads it is the only one who can fix it.
 */
const NO_ADMINS =
  "Nobody in this space is an ADMIN any more, so no member can manage it — publish reviews, " +
  "restore deleted pages or change its membership. A super admin still can. Promote someone if " +
  "that was not deliberate.";

/** `FormData.get` returns `File | string | null`; every input here is a text input. */
function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * The five inputs, shared by the create form and every edit form so the two cannot drift apart.
 *
 * `space === undefined` is the create case. The `visibility` and `role` options are spelled out
 * rather than derived from Prisma's enums, because this is a client component and importing
 * `@prisma/client` for a handful of strings would pull the generated client into the browser
 * bundle — `AdminSystems`'s reason. The endpoints validate against the real enums with
 * `z.enum(SpaceVisibility)`, so a value these lists forget is refused rather than stored; the
 * lists can be wrong in the safe direction only.
 */
function Fields({ space, errors }: { space?: AdminSpaceRow; errors?: SpaceFieldError[] }) {
  const error = (field: string) => errors?.find((each) => each.field === field);
  const locked = space !== undefined && space.pages > 0;
  return (
    <>
      <Field label="Key" field="key" error={error("key")}>
        <input
          className="adm-input"
          name="key"
          defaultValue={space?.key ?? ""}
          placeholder="engineering"
          autoComplete="off"
          spellCheck={false}
          /*
           * Disabled once the space holds a page, with the reason beside it. An affordance and not
           * the rule: `updateSpace` refuses the rename with a sentence and a count whatever this
           * form sends, which is what the integration test drives directly.
           */
          disabled={locked}
        />
      </Field>
      {locked ? (
        <p className="adm-note">
          The key is fixed once a space holds pages: it is in every one of their URLs and is the
          directory the git mirror wrote their files into.
        </p>
      ) : null}

      <Field label="Name" field="name" error={error("name")}>
        <input
          className="adm-input"
          name="name"
          defaultValue={space?.name ?? ""}
          placeholder="Engineering"
          autoComplete="off"
        />
      </Field>

      <Field label="Initials" field="initials" error={error("initials")}>
        <input
          className="adm-input"
          name="initials"
          defaultValue={space?.initials ?? ""}
          placeholder="EN"
          autoComplete="off"
        />
      </Field>

      <Field label="Visibility" field="visibility" error={error("visibility")}>
        <select
          className="adm-input"
          name="visibility"
          defaultValue={space?.visibility ?? "MEMBERS"}
        >
          {VISIBILITIES.map((visibility) => (
            <option key={visibility} value={visibility}>
              {visibility === "MEMBERS"
                ? "MEMBERS — only the people listed below"
                : "ALL_STAFF — everyone who can sign in"}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Description" field="description" error={error("description")}>
        <textarea
          className="adm-input adm-area"
          name="description"
          rows={2}
          defaultValue={space?.description ?? ""}
        />
      </Field>
    </>
  );
}

function Field({
  label,
  field,
  error,
  children,
}: {
  label: string;
  field: string;
  error?: SpaceFieldError;
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

/** The whole-form sentence: a refused rename, a widened space, or an unreachable server. */
function Message({ feedback }: { feedback?: Feedback }) {
  if (feedback?.message === undefined) return null;
  return (
    <p className="adm-message" role="alert">
      {feedback.message}
    </p>
  );
}

/**
 * Who is in the space, and the controls that change it.
 *
 * Names and email addresses from a space the admin may not belong to, which is why fetching this
 * wrote an audit row. The role control is a `select` that submits on change rather than a form
 * with a save button: a role is one enum value and an intermediate "unsaved role" state is a lie
 * the page would have to hold.
 */
function MemberList({
  listed,
  busy,
  onRole,
  onRemove,
  onAdd,
  errors,
}: {
  listed: Members;
  busy: boolean;
  onRole: (userId: string, role: string) => void;
  onRemove: (userId: string) => void;
  onAdd: (form: HTMLFormElement) => void;
  errors?: SpaceFieldError[];
}) {
  const emailError = errors?.find((each) => each.field === "email");
  return (
    <>
      <ul className="adm-members">
        {listed.list.length === 0 ? (
          <li className="adm-member adm-more">Nobody is a member of this space.</li>
        ) : null}
        {listed.list.map((member) => (
          <li className="adm-member" key={member.userId}>
            <span className="adm-page-title">{member.name}</span>
            <span className="adm-email">{member.email}</span>
            <select
              className="adm-role"
              aria-label={`Role for ${member.email}`}
              value={member.role}
              disabled={busy}
              onChange={(event) => onRole(member.userId, event.currentTarget.value)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button
              className="adm-btn"
              type="button"
              disabled={busy}
              onClick={() => onRemove(member.userId)}
            >
              Remove
            </button>
          </li>
        ))}
        {listed.truncated ? (
          <li className="adm-member adm-more">
            More people are members of this space than are listed here.
          </li>
        ) : null}
      </ul>

      <form
        className="adm-form"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd(event.currentTarget);
        }}
      >
        <Field label="Add by email" field="email" error={emailError}>
          <input
            className="adm-input"
            name="email"
            type="email"
            placeholder="someone@example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Role" field="role">
          <select className="adm-input" name="role" defaultValue="VIEWER">
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </Field>
        <p className="adm-actions">
          <button className="adm-btn adm-primary" type="submit" disabled={busy}>
            Add member
          </button>
        </p>
      </form>
    </>
  );
}
