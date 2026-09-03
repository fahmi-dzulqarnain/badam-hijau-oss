export const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

/**
 * A date **and** a time, for a list where two rows can legitimately fall on the same day.
 *
 * The version history is the first such list: fixing a typo produces a second version minutes
 * after the first, and three rows all reading `4 Mar 2026` would make the ordering look arbitrary
 * and hide the thing history is for. Every other list in the product is one row per page, where
 * the day is the useful granularity and a time is noise.
 *
 * **The same locale and the same zone as `dateFormat`** — which is the server's zone, since
 * neither pins one. That is the point rather than an omission: a page whose meta row says
 * `4 Mar 2026` and whose history says `3 Mar 2026, 23:30` for the same publish would be two
 * surfaces disagreeing about which day it happened, and pinning UTC here alone is exactly how
 * that arrives. Both formats are used only in server-rendered output, so there is no
 * hydration mismatch to answer for; `Editor.tsx` builds its own clock in the browser and
 * documents why.
 */
export const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});
