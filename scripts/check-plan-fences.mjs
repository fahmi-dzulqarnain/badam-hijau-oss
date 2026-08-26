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
/**
 * Languages whose fences are checked. `bash` and `sh` are here because leaving them out was a
 * real hole, not an oversight to inherit: `scripts/smoke.sh` is quoted whole-file by the Phase 1
 * plan, Phase 2 extended it, and the fence went on claiming byte-identity while landing in the
 * "not code" bucket — a shell script could drift indefinitely and silently. Fifth time on this
 * project that a guard could not see a whole category of the thing it guards.
 *
 * Most `bash` fences in these plans are command snippets, not files; they simply find no path
 * reference above them and are skipped, exactly as before.
 */
const CODE_LANGS = new Set(["ts", "tsx", "js", "mjs", "json", "css", "prisma", "bash", "sh"]);
const LOOKBACK = 12;

/**
 * Fences are matched to files by the path written above them, and the plan's own step
 * wording says whether the fence is meant to be the *whole* file: "Step 4: Create `x`" or
 * "Replace `x`" promises the entire file, while "add", "append" and "extend" introduce a
 * fragment. That distinction is the whole point — a fence promising a whole file that no
 * longer matches it is drift, and must not be allowed to hide.
 */
/**
 * A fence's language constrains which file it can possibly be. Without this, a `bash` command
 * snippet sitting under "Step N: Create `src/app/page.tsx`" binds to that file and is reported
 * as drift — which is exactly what happened the moment shell fences were added to the checked
 * set. A shell fence is never a `.tsx` file.
 */
const EXTENSIONS = {
  ts: [".ts"],
  tsx: [".tsx"],
  js: [".js", ".mjs", ".cjs"],
  mjs: [".mjs", ".js"],
  json: [".json"],
  css: [".css"],
  prisma: [".prisma"],
  bash: [".sh"],
  sh: [".sh"],
};

function findQuotedPath(lines, fenceLine, lang) {
  const allowed = EXTENSIONS[lang] ?? [];
  const plausible = (p) => allowed.some((ext) => p.endsWith(ext));

  const exists = (p) => (plausible(p) && existsSync(join(ROOT, p)) ? p : null);

  // Walk back from the fence and take the FIRST path reference of either kind. Whichever is
  // closest wins, and whether it was a `Step N: Create \`x\`` directive is what decides
  // `wholeFile`.
  //
  // Three failure modes were hit getting here, and all three were silent or spurious:
  //
  //  - Two separate lookbacks, 12 lines for the directive: a supersession note between a
  //    heading and its fence pushed the directive out of reach, `wholeFile` silently became
  //    false, and the fence dropped into the `unmatched` bin — the very bin this tool grew a
  //    `--verbose` flag for. Caught only by watching the counts move by one.
  //  - Widening that to 40: immediately mis-bound three fences to the *previous* step's file
  //    and reported drift that did not exist.
  //  - "Nearest step heading decides": over-claimed, because the plan puts several fences under
  //    one heading — a component and a stylesheet both landed on an API route's step.
  //
  // Blockquote lines are skipped: every supersession note is a blockquote and names the file it
  // supersedes, so counting those would re-create the first failure.
  for (let i = fenceLine - 1; i >= Math.max(0, fenceLine - LOOKBACK * 2); i--) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;

    const directive = line.match(
      /\*\*Step \d+:\s*(Create|Replace|Rewrite)[^`]*`([^`\s]+\.[a-z]{2,6})`/i,
    );
    if (directive) {
      const p = exists(directive[2].replace(/^\.\//, ""));
      if (p) return { path: p, wholeFile: true };
    }

    for (const m of line.matchAll(/`([^`\s]+\.[a-z]{2,6})`/g)) {
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
    const match = findQuotedPath(lines, fence.openLine, fence.lang);
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

    // An explicit supersession note outranks the first-line heuristic. Without this, annotating a
    // stale fence was decorative: a fence whose file gained an *import* has a different first
    // line, so it was dismissed as `unmatched` before this check could see the note — and the
    // only signal was `in sync` falling by one while `unmatched` rose by one. Measured on this
    // repository, on `TopBar.tsx`, by the change that added the search link.
    if (a !== b && !b.includes(a) && isSuperseded(lines, fence.openLine)) {
      results.superseded++;
      continue;
    }

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
