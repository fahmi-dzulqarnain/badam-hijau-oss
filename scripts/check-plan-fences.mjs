#!/usr/bin/env node
// Reports drift between the code fences in docs/superpowers/plans/*.md and the files they
// quote. Read-only by design.
//
//   npm run plan:check
//
// Why this exists: the plans are kept byte-identical to the shipped code, and that was being
// done with throwaway scripts that rewrote every fence in a section from a list of files. One
// of those steps says "append this function to the file" and quotes a *fragment*; a blind
// sync replaced it with the whole file, silently turning an append step into a replace step.
// Nothing failed — the plan just started lying.
//
// So the rule this encodes is: a fence that appears verbatim *inside* a file is a FRAGMENT
// and must never be whole-file synced. Only an exact whole-file match can be.
//
// Fences are matched to files by the backticked path the plan writes just above them. A fence
// with no such path nearby is prose or shell and is skipped. A fence the plan explicitly
// marks as superseded is reported separately rather than as drift.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PLAN_DIR = join(ROOT, "docs/superpowers/plans");
const CODE_LANGS = new Set(["ts", "tsx", "js", "mjs", "json", "css", "prisma"]);
const LOOKBACK = 12;

/**
 * Fences are matched to files by the path written above them, and the plan's own step
 * wording says whether the fence is meant to be the *whole* file: "Step 4: Create `x`" or
 * "Replace `x`" promises the entire file, while "add", "append" and "extend" introduce a
 * fragment. That distinction is the whole point — a fence promising a whole file that no
 * longer matches it is drift, and must not be allowed to hide.
 */
function findQuotedPath(lines, fenceLine) {
  const exists = (p) => (existsSync(join(ROOT, p)) ? p : null);

  for (let i = fenceLine - 1; i >= Math.max(0, fenceLine - LOOKBACK); i--) {
    const directive = lines[i].match(
      /\*\*Step \d+:\s*(Create|Replace|Rewrite)[^`]*`([^`\s]+\.[a-z]{2,6})`/i,
    );
    if (directive) {
      const p = exists(directive[2].replace(/^\.\//, ""));
      if (p) return { path: p, wholeFile: true };
    }
  }

  for (let i = fenceLine - 1; i >= Math.max(0, fenceLine - LOOKBACK); i--) {
    for (const m of lines[i].matchAll(/`([^`\s]+\.[a-z]{2,6})`/g)) {
      const p = exists(m[1].replace(/^\.\//, ""));
      if (p) return { path: p, wholeFile: false };
    }
  }
  return null;
}

function isSuperseded(lines, fenceLine) {
  const window = lines
    .slice(Math.max(0, fenceLine - LOOKBACK), fenceLine)
    .join(" ")
    .toLowerCase();
  return /supersede|already shipped|do not apply|no longer matches/.test(window);
}

function fences(text) {
  const lines = text.split("\n");
  const out = [];
  let start = null;
  let lang = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start === null && t.startsWith("```") && t.length > 3) {
      start = i;
      lang = t.slice(3).trim();
    } else if (start !== null && t === "```") {
      out.push({ lang, openLine: start, body: lines.slice(start + 1, i).join("\n") });
      start = null;
    }
  }
  return { lines, out };
}

const results = { synced: 0, fragment: 0, superseded: 0, skipped: 0, unmatched: 0, unmatchedAt: [], drift: [] };

for (const name of readdirSync(PLAN_DIR).filter((f) => f.endsWith(".md"))) {
  const path = join(PLAN_DIR, name);
  const text = readFileSync(path, "utf8");
  const { lines, out } = fences(text);

  for (const fence of out) {
    if (!CODE_LANGS.has(fence.lang)) {
      results.skipped++;
      continue;
    }
    const match = findQuotedPath(lines, fence.openLine);
    if (!match) {
      results.skipped++;
      continue;
    }
    const quoted = match.path;

    const fileText = readFileSync(join(ROOT, quoted), "utf8");
    const a = fence.body.trim();
    const b = fileText.trim();

    // A fence under "Create `x`" claims to BE x, so a mismatch is always reportable — even
    // when it has diverged so far that the first lines differ. That case is exactly how a
    // stale RailFoot snapshot hid here once. Only a loosely-matched fence, where the path
    // came from surrounding prose rather than a step directive, may be dismissed.
    const firstLine = (s) => (s.split("\n").find((l) => l.trim()) ?? "").trim();
    if (!match.wholeFile && a !== b && !b.includes(a) && firstLine(a) !== firstLine(b)) {
      results.unmatched++;
      results.unmatchedAt.push({ plan: relative(ROOT, path), line: fence.openLine + 1, guess: quoted });
      continue;
    }

    if (a === b) {
      results.synced++;
    } else if (b.includes(a) && !match.wholeFile) {
      // A verbatim slice of the file: an "append this" or "add this block" step.
      // Correct as-is, and the one shape a whole-file sync would destroy.
      results.fragment++;
    } else if (isSuperseded(lines, fence.openLine)) {
      results.superseded++;
    } else {
      results.drift.push({
        plan: relative(ROOT, path),
        line: fence.openLine + 1,
        file: quoted,
      });
    }
  }
}

const { synced, fragment, superseded, skipped, unmatched, unmatchedAt, drift } = results;
console.log(
  `${synced} in sync · ${fragment} fragment · ${superseded} superseded · ` +
    `${unmatched} unmatched · ${skipped} not code · ${drift.length} drifted`,
);

// "unmatched" is the bin for fences this tool cannot classify, and a bin reported only as a
// number is where a stale fence hides — a RailFoot snapshot did exactly that. `--verbose`
// prints them so the bin can be audited rather than trusted.
if (unmatched > 0) {
  console.log("  (run with --verbose to list the unmatched fences)");
  if (process.argv.includes("--verbose")) {
    for (const u of unmatchedAt) console.log(`    ${u.plan}:${u.line}  nearest path: ${u.guess}`);
  }
}

if (drift.length > 0) {
  console.log("\nFences that no longer match the file they quote:\n");
  for (const d of drift) console.log(`  ${d.plan}:${d.line}  ->  ${d.file}`);
  console.log(
    "\nSync a whole-file fence from its file. Never sync a fragment — check first that\n" +
      "the fence is meant to be the entire file and not an excerpt.",
  );
  process.exit(1);
}
