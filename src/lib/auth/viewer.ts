import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { viewerForEmail } from "@/lib/users/viewer";
import type { Viewer } from "@/lib/authz/types";

/**
 * Wrapped in `cache()` so one render sees one Viewer OBJECT, not just one equal value.
 * The repository's own `cache()` calls key on argument identity, so a fresh Viewer per
 * call would miss every time and silently make that memoization useless. Note `cache()`
 * only memoizes inside a real RSC render — it is a passthrough everywhere else.
 */
export const loadViewer = cache(async (): Promise<Viewer | null> => {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  return viewerForEmail(email);
});

export async function requireViewer(callbackUrl?: string): Promise<Viewer> {
  const viewer = await loadViewer();
  if (!viewer) {
    // Relative paths only. Auth.js clamps to the origin as well, but rejecting
    // protocol-relative "//evil.example" belongs at the boundary we own rather than
    // relying on a downstream library's guard.
    const safe =
      typeof callbackUrl === "string" &&
      callbackUrl.startsWith("/") &&
      !callbackUrl.startsWith("//");
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(safe ? callbackUrl : "/")}`);
  }
  return viewer;
}
