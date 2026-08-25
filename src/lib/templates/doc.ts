/** The doc template — deliberately the shortest. See `load.ts` for why this is a `.ts` file. */
export const DOC_TEMPLATE = `---
# Every key a doc may declare, listed empty. Empty means "nothing declared", which is why an
# unfilled template publishes: \`status:\` asks for no particular status, so the first publish
# uses this type's entry state.
#
# \`related:\` names its target by space-relative page path — what you see in the URL and the
# nav rail — for example architecture/mqtt-contracts. One path, or a list of them.
status:
systems:
related:
---

## Overview

What this page is for, in a sentence or two, so someone arriving from search knows whether
they are in the right place before they read on.

## Details

The substance. A doc has no fixed shape, which is why this template stops here — rename this
heading, or replace it with as many as the subject needs.
`;
