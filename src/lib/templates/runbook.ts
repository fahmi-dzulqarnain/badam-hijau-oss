/** The runbook template. See `src/lib/templates/load.ts` for why this is a `.ts` file. */
export const RUNBOOK_TEMPLATE = `---
# Every key a runbook may declare, listed empty. Empty means "nothing declared", which is why
# an unfilled template publishes: \`status:\` asks for no particular status, so the first
# publish uses this type's entry state.
#
# \`related:\` names its target by space-relative page path — what you see in the URL and the
# nav rail — for example architecture/mqtt-contracts. One path, or a list of them.
status:
systems:
related:
---

## Symptoms

What someone reaching for this page is looking at: the alert name, the error text, the graph
that has gone the wrong way. Write the words they will search for, not a paraphrase of them.

## Checks

The ordered checks that narrow it down, cheapest and safest first. Give the command or the
dashboard for each, and say what a healthy answer looks like — a check with no expected value
cannot be run by someone who has never seen this healthy.

## Fix

What to do, step by step, including anything that must happen in a particular order or not at
all. Mark the steps that are destructive, and the ones that page other people.

## Escalation

Who to wake, when it is fair to wake them, and what to hand over. Also: when to stop
following this runbook, which is the step people most often need permission to take.
`;
