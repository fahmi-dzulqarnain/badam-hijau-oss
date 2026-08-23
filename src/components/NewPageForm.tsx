"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { CreateFieldError } from "@/lib/pages/create";

/**
 * What the server action hands back. `error` is a field rejection from `createPage`, rendered
 * against the input it names; `message` is everything that belongs to no field — the two
 * permission refusals, which the form can only state.
 */
export type NewPageState = { error?: CreateFieldError; message?: string };

export type ParentOption = { id: string; spaceId: string; title: string; path: string };
export type SpaceOption = { id: string; key: string; name: string };

const DOC_TYPES = [
  ["DOC", "Doc"],
  ["ADR", "ADR"],
  ["RFC", "RFC"],
  ["RUNBOOK", "Runbook"],
] as const;

/**
 * Mirrors `validateSlug`'s accepted shape well enough to produce a legal suggestion, and is
 * deliberately NOT the validation — that lives on the server, where it cannot be skipped by
 * posting the form by hand. If the two ever disagree the server wins and the editor sees the
 * field error, which is a worse experience but never a wrong page.
 *
 * The leading-hyphen trim is the one rule worth restating here: `-` is reserved for
 * application routes, and a title starting with punctuation would otherwise suggest a slug
 * the server is bound to reject.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

export function NewPageForm({
  spaces,
  parents,
  action,
}: {
  spaces: SpaceOption[];
  parents: ParentOption[];
  action: (state: NewPageState, form: FormData) => Promise<NewPageState>;
}) {
  const [state, submit, pending] = useActionState(action, {});

  // Every field is controlled, and that is the whole reason: a rejection re-renders this
  // form, and an uncontrolled `<select>` comes back at its default. Measured in the browser
  // — an occupied-path rejection reset "Parent page" to "None", so the editor's next attempt
  // silently created a top-level page instead of the child they had chosen. Losing an input
  // while showing an error about a different one is the worst version of this failure.
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
  const [parentId, setParentId] = useState("");
  const [docType, setDocType] = useState<string>("DOC");
  const [title, setTitle] = useState("");
  // Null until the editor types in the slug field: the suggestion follows the title right up
  // to the moment they take it over, and never afterwards. A slug that silently reverted to
  // the title's shape on the next keystroke would be worse than no prefill at all.
  const [slug, setSlug] = useState<string | null>(null);

  const suggested = slugify(title);
  const slugValue = slug ?? suggested;

  // Only the chosen space's pages can be parents — `createPage` refuses a parent from
  // another space, so offering one would be an option that cannot work.
  const available = useMemo(
    () => parents.filter((p) => p.spaceId === spaceId),
    [parents, spaceId],
  );

  /**
   * React 19 resets the form after a form action, and a controlled `<select>` does not come
   * back from that on its own: the reconciler only re-applies `selected` when the `value`
   * prop CHANGES, and after a rejection it has not. A controlled `<input>` survives because
   * its value tracker re-applies on every commit — which is why the wart showed up on the
   * two selects and nowhere else.
   *
   * Measured in the browser before this was added: an occupied-path rejection left "Parent
   * page" reading "None", so the obvious next move — change the slug, submit again — created
   * a top-level page instead of the child. Losing one input while pointing at another is the
   * worst version of this, because nothing on screen says it happened.
   *
   * A passive effect runs after the commit that performs the reset, so this re-applies both.
   */
  const parentRef = useRef<HTMLSelectElement>(null);
  const docTypeRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (parentRef.current) parentRef.current.value = parentId;
    if (docTypeRef.current) docTypeRef.current.value = docType;
  }, [state, parentId, docType]);

  const errorFor = (field: CreateFieldError["field"]) =>
    state.error?.field === field ? state.error.message : null;

  if (spaces.length === 0) {
    return (
      <p className="np-empty">
        You do not have edit access to any space, so there is nowhere to create a page. Ask a
        space admin for the Editor role.
      </p>
    );
  }

  return (
    <form className="np-form" action={submit}>
      {state.message ? (
        <p className="np-error" role="alert">
          {state.message}
        </p>
      ) : null}

      <label htmlFor="np-space">Space</label>
      <select
        id="np-space"
        name="spaceId"
        value={spaceId}
        onChange={(event) => {
          setSpaceId(event.target.value);
          // The chosen parent belongs to the old space and `createPage` would refuse it.
          setParentId("");
        }}
      >
        {spaces.map((space) => (
          <option key={space.id} value={space.id}>
            {space.name}
          </option>
        ))}
      </select>

      <label htmlFor="np-parent">Parent page</label>
      <select
        id="np-parent"
        name="parentId"
        ref={parentRef}
        value={parentId}
        onChange={(event) => setParentId(event.target.value)}
      >
        <option value="">None — top level of the space</option>
        {available.map((parent) => (
          <option key={parent.id} value={parent.id}>
            {parent.title} — {parent.path}
          </option>
        ))}
      </select>
      {errorFor("parentId") ? (
        <p className="np-error" role="alert">
          {errorFor("parentId")}
        </p>
      ) : null}

      <label htmlFor="np-title">Title</label>
      <input
        id="np-title"
        name="title"
        value={title}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
      />
      {errorFor("title") ? (
        <p className="np-error" role="alert">
          {errorFor("title")}
        </p>
      ) : null}

      <label htmlFor="np-slug">Slug</label>
      <input
        id="np-slug"
        name="slug"
        value={slugValue}
        onChange={(event) => setSlug(event.target.value)}
      />
      <p className="np-hint">
        The last segment of the page&rsquo;s URL. Lowercase letters, numbers and hyphens.
      </p>
      {errorFor("slug") ? (
        <p className="np-error" role="alert">
          {errorFor("slug")}
        </p>
      ) : null}

      <label htmlFor="np-doctype">Doc type</label>
      <select
        id="np-doctype"
        name="docType"
        ref={docTypeRef}
        value={docType}
        onChange={(event) => setDocType(event.target.value)}
      >
        {DOC_TYPES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <div className="np-actions">
        <button type="submit" disabled={pending || title.trim() === ""}>
          {pending ? "Creating" : "Create draft"}
        </button>
      </div>
      <p className="np-hint">
        The page is created as a draft: it stays out of the reader and shows as inert text in
        the nav rail until you publish it.
      </p>
    </form>
  );
}
