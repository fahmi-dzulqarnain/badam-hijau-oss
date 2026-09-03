/**
 * `/api/attachments/{id}/video` serves exactly what `/api/attachments/{id}` serves.
 *
 * The suffix exists so a Markdown image reference can carry a discriminator the render plugin
 * can match — `![clip](/api/attachments/abc/video)` becomes a `<video>` element while
 * `![shot](/api/attachments/abc)` stays an `<img>`. Markdown has no other way to say
 * "this one is a video".
 *
 * Re-exported rather than reimplemented. A second copy of this handler would be a second copy
 * of the permission check, and the two would eventually disagree — the failure this repository
 * has already had once, with the never-spread predicate.
 */
export { GET, HEAD } from "../route";
