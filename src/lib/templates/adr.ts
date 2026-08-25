/**
 * The ADR template. See `src/lib/templates/load.ts` for why this is a `.ts` file exporting a
 * string rather than the `adr.md` the plan asked for — the short version is that a `.md` file
 * cannot be read from the RSC layer of a `next build` server, measured.
 *
 * Nothing but the document below. If a heading ever needs inline code, the backtick has to be
 * escaped; TypeScript says so, loudly, at compile time.
 */
export const ADR_TEMPLATE = `---
# Every key an ADR may declare, listed empty. Empty means "nothing declared", which is why an
# unfilled template publishes: \`status:\` asks for no particular status, so the first publish
# uses this type's entry state.
#
# The four relation keys name their target by its space-relative page path — what you see in
# the URL and the nav rail — for example decisions/adr-0031-mqtt-topic-naming. One path, or a
# list of them.
status:
systems:
related:
supersedes:
amends:
decides:
---

## Context

What forced a decision. The constraint, the incident, the thing that stopped working — enough
that someone arriving in a year understands the pressure without having to find you.

## Decision

The decision itself, in the present tense: "we do X". If alternatives were seriously
considered, name them here with the one reason each was set aside.

## Consequences

What this buys and what it costs, including the parts that are worse. A consequences section
with nothing uncomfortable in it usually means the decision has not been thought through yet.
`;
