import type { DocType } from "@prisma/client";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { createPage, listEditableSpaces } from "@/lib/pages/create";
import { listSpacePages } from "@/lib/pages/repo";
import { NewPageForm } from "@/components/NewPageForm";
import type { NewPageState, ParentOption } from "@/components/NewPageForm";

const DOC_TYPES: readonly DocType[] = ["DOC", "ADR", "RFC", "RUNBOOK"];

/** A select is a suggestion, not a constraint: the value arrives as an untrusted string. */
function parseDocType(value: FormDataEntryValue | null): DocType {
  const found = DOC_TYPES.find((type) => type === value);
  return found ?? "DOC";
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

/**
 * Creating a page.
 *
 * The form offers only spaces the viewer may edit and only parents inside them, but none of
 * that is the authorisation: `createPage` re-resolves the space, re-checks `EDIT`, and
 * re-validates the parent. A hand-posted `spaceId` gets the same not-found a stranger gets.
 */
export default async function NewPage() {
  const viewer = await requireViewer("/new");

  const spaces = await listEditableSpaces(viewer);

  // One query per editable space rather than one query across all of them: `listSpacePages`
  // states its own permission predicate and its own soft-delete filter, which is the whole
  // reason to go through the repository instead of querying the page table from a route.
  const parents: ParentOption[] = (
    await Promise.all(
      spaces.map(async (space) =>
        (await listSpacePages(viewer, space.id)).map((page) => ({
          id: page.id,
          spaceId: space.id,
          title: page.title,
          path: page.path,
        })),
      ),
    )
  ).flat();

  async function submit(_state: NewPageState, form: FormData): Promise<NewPageState> {
    "use server";

    // Re-loaded inside the action. A server action is a POST endpoint of its own, reachable
    // without ever rendering the page above it, so the viewer this closure needs is the one
    // holding the cookie now — not one captured at render time.
    const actor = await requireViewer("/new");

    const parentId = text(form.get("parentId"));
    const result = await createPage(actor, {
      spaceId: text(form.get("spaceId")),
      // "" is the form's way of saying "top level"; the repository wants a real null.
      parentId: parentId === "" ? null : parentId,
      slug: text(form.get("slug")),
      title: text(form.get("title")),
      docType: parseDocType(form.get("docType")),
    });

    if (result.ok) {
      // `redirect` throws, so nothing after it runs. Task 7 builds this route; until then it
      // 404s, which is the plan's stated sequencing rather than an oversight here.
      redirect(`/edit/${result.page.id}`);
    }

    switch (result.reason) {
      case "invalid":
        return { error: result.error };

      // Deliberately worded as "no longer available", not "does not exist": the space was in
      // the select a moment ago. It also has to read the same for a space that never existed
      // and for one this viewer cannot see, because the repository refuses to tell those
      // apart and the form must not undo that.
      case "not-found":
        return { message: "That space is no longer available. Reload and try again." };

      case "forbidden":
        return { message: "You do not have permission to create pages in that space." };
    }
  }

  return (
    <main className="np">
      <h1>New page</h1>
      <NewPageForm
        spaces={spaces.map((space) => ({ id: space.id, key: space.key, name: space.name }))}
        parents={parents}
        action={submit}
      />
    </main>
  );
}
