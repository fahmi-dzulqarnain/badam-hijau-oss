/** The RFC template. See `src/lib/templates/load.ts` for why this is a `.ts` file. */
export const RFC_TEMPLATE = `---
# Every key an RFC may declare, listed empty. Empty means "nothing declared", which is why an
# unfilled template publishes: \`status:\` asks for no particular status, so the first publish
# uses this type's entry state.
#
# \`related:\` and \`amends:\` name their target by space-relative page path — what you see in
# the URL and the nav rail — for example proposals/rfc-0004-fuel-price-sync. One path, or a
# list of them. \`amends:\` names another RFC this one modifies without replacing: an accepted
# RFC is a record, so it is amended by a later RFC rather than rewritten.
# An RFC does not declare \`supersedes:\` or \`decides:\`; the ADR that closes this RFC declares
# \`decides:\` pointing back here.
status:
systems:
related:
amends:
---

## Summary

The proposal in a paragraph, written so a reader can decide from it alone whether to read the
rest. Say what changes, and for whom.

## Motivation

The problem this exists to solve, and what happens if nothing is done. Concrete beats
abstract: the request that could not be answered, the outage, the number that is wrong.

## Design

How it works. Interfaces, data, and the sequence of events — enough for someone else to
implement it and get the same thing. Say what is deliberately out of scope.

## Open questions

What is still undecided, each with who or what would settle it. An RFC with no open questions
is either finished or not yet honest.
`;
