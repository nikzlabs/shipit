/**
 * Which declared dep dirs are empty because npm HOISTED their package's
 * dependencies somewhere else? (planning#480.)
 *
 * ## The hole this closes
 *
 * `overlay-dep-check.ts` documents an escape hatch: an **absent** dep dir is not
 * a contradiction, because "a repo that legitimately has no install-managed dep
 * dir … has that dir absent". docs/272 then made the same predicate fatal on the
 * post-install side.
 *
 * The overlay dep store (docs/183) makes that escape hatch **unreachable**. It
 * mounts an overlay at every declared dep dir, and a mount point is a directory:
 * inside the container a declared dep dir is never absent, only ever present —
 * and, when the install does not fill it, present-and-EMPTY. So the exact repo
 * shape the hatch was written for lands in the fatal branch instead.
 *
 * The field case is an npm **workspaces** monorepo declaring
 * `[node_modules, server/node_modules, web/node_modules]`. A root `npm install`
 * hoists every package into the root `node_modules` and creates no
 * `server/node_modules` at all — so with the overlay on, that mount point stays
 * empty forever, and every session of the repo reported a permanent install
 * failure while the app itself ran correctly. Nothing the install could do would
 * clear it; only editing `agent.dep-dirs` would.
 *
 * ## Why npm's own record, and not a looser rule
 *
 * The obvious loosening — fail only when EVERY declared dep dir is empty — was
 * rejected. It keeps the exact field case docs/272 was built for (a laundered
 * `npm ci … || [ -x node_modules/.bin/vite ]` leaves all of them empty), but it
 * opens a new one: a monorepo whose ROOT install succeeds and whose sub-install
 * is laundered has a populated root and an empty sub-dir, and would pass. It
 * trades one silent gate-opening for another.
 *
 * npm already records the answer, in the hidden lockfile
 * (`node_modules/.package-lock.json`) it writes into the tree it reified —
 * npm's own statement of what it put on disk. Two entry kinds matter, and
 * **both halves are load-bearing**:
 *
 *  - A **link** entry (`{ "resolved": "server", "link": true }`) says npm
 *    reified `server` as a symlink in this tree rather than a copy.
 *  - An entry keyed **under that target's own `node_modules/`**
 *    (`server/node_modules/lodash`) says npm ALSO put a nested tree there,
 *    because that dependency could not hoist.
 *
 * A link alone therefore proves nothing about the workspace's own dep dir.
 * Verified against npm 10 and 11: a root depending on `lodash@4` with a
 * workspace `server` depending on `lodash@3` produces BOTH
 * `node_modules/@scope/server → link` and `server/node_modules/lodash@3.10.1` in
 * the same root hidden lockfile — and npm creates `server/node_modules` on disk.
 * A sibling `web` with no conflict gets the link and no nested entries, and no
 * directory at all. So the exemption requires the link AND the absence of any
 * required entry beneath it: npm saying, in its own record, that it deliberately
 * put nothing there.
 *
 * "Required" is {@link isRequiredTreeEntry}, shared verbatim with the staleness
 * check — an optional, peer, bundled or platform-restricted nested package is
 * legitimately absent, and demanding it would fail an install that succeeded.
 * One rule set for both callers, because both are answering "should this
 * directory hold something" and a drift between them would let one check fail a
 * repo the other excuses.
 *
 * (`link: true` is not workspace-specific — npm writes it for `file:` local
 * dependencies too. That is fine here: the question this module answers is
 * whether npm put the package's dependencies somewhere other than its own dep
 * dir, and the answer is read from the record either way.)
 *
 * ## Why this cannot weaken the checks it sits inside
 *
 * Every exemption requires a hidden lockfile in an ANCESTOR dep tree, which only
 * exists when that tree is populated and npm itself wrote it:
 *
 *  - **A laundered install exit** (docs/272's field case) leaves the root tree
 *    empty, so there is no hidden lockfile to read and nothing is exempted. A
 *    repo declaring a single dep dir is never exempted at all — a root-level
 *    `node_modules` has no ancestor package to be hoisted into.
 *  - **A freshly-enabled overlay** (docs/183 mode 1) and **a rolled-back flag**
 *    (mode 2) both leave empty mount points. Where the root dep dir is declared
 *    it is empty too, so nothing is exempted. Where only a NESTED dep dir is
 *    declared, the ancestor tree survives in the clone and its record is read —
 *    and that record is exactly what says whether the empty mount point is
 *    supposed to hold anything. A conflicting nested dependency disqualifies the
 *    exemption and the reinstall fires; a fully hoisted workspace has nothing to
 *    reinstall INTO that dir, so honoring the skip loses nothing.
 *  - **Publishing an empty shared base** is refused independently, at
 *    `overlay-publish.ts:240` (`skipped-empty`), so an exempted empty dir cannot
 *    become a scope's rolling base by this route either.
 *
 * Path handling is lexical, and the ancestor read follows symlinks. That is
 * deliberate rather than overlooked: the only actor who can point an ancestor
 * path at a foreign lockfile is the repo itself, and a repo that wants its empty
 * dep dir excused can already do so far more directly by having `agent.install`
 * write one file into it. Symlink-resolving the walk would add cost to every
 * install and buy nothing an adversary does not already have.
 *
 * Cost: at most one `readFileSync` + `JSON.parse` per ancestor directory, and
 * only for dep dirs already found empty. Never a tree walk.
 */

import fs from "node:fs";
import path from "node:path";
import {
  HIDDEN_LOCKFILE,
  isRequiredTreeEntry,
  parsePackages,
  treeRecordsDevPackages,
} from "./dep-tree-staleness.js";

/**
 * Normalize a lockfile `resolved` path into the same shape `agent.dep-dirs`
 * entries are normalized to (posix segments, no `.`, no trailing slash), or
 * `null` when it is not a plain relative in-tree path. `file:` prefixes are
 * tolerated because older npm versions wrote link targets that way; absolute
 * paths, URLs and `..`-escapes cannot name a declared dep dir, so they are
 * dropped rather than matched.
 */
function normalizeLinkTarget(resolved: string): string | null {
  const raw = resolved.trim().replace(/^file:/, "");
  if (!raw || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const segments = raw.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return null;
  return segments.join("/");
}

/**
 * The package paths this lockfile records as linked **and** as holding no
 * dependency tree of their own — the packages whose dependencies npm hoisted
 * into the tree the lockfile describes.
 *
 * A linked target with any required entry under its own `node_modules/` is
 * deliberately NOT returned: npm put a nested tree there, so an empty directory
 * at that path contradicts npm's record rather than confirming it. This is the
 * half that keeps a conflicting workspace (and a laundered sub-install over one)
 * failing.
 *
 * Pure (takes the text) so the whole rule is unit-testable without a filesystem.
 * Anything unparseable, non-v2+, or otherwise not a `packages` map yields an
 * empty set — the direction that exempts nothing, never the direction that
 * exempts everything.
 */
export function hoistedLinkTargets(lockfileText: string): Set<string> {
  const packages = parsePackages(lockfileText);
  if (packages === null) return new Set();

  const hoisted = new Set<string>();
  for (const entry of Object.values(packages)) {
    if (typeof entry !== "object" || entry === null) continue;
    const resolved: unknown = entry.resolved;
    if (entry.link !== true || typeof resolved !== "string") continue;
    const normalized = normalizeLinkTarget(resolved);
    if (normalized) hoisted.add(normalized);
  }
  if (hoisted.size === 0) return hoisted;

  // Drop every target npm's own record says has a nested tree of its own. The
  // key shape is `<target>/node_modules/<pkg>`; the FIRST `/node_modules/` is
  // what names the owner, so a deeper `a/node_modules/b/node_modules/c` still
  // attributes to `a`.
  const treeHasDev = treeRecordsDevPackages(packages);
  for (const [key, entry] of Object.entries(packages)) {
    if (typeof entry !== "object" || entry === null) continue;
    const boundary = key.indexOf("/node_modules/");
    if (boundary <= 0) continue;
    const owner = key.slice(0, boundary);
    if (!hoisted.has(owner)) continue;
    if (isRequiredTreeEntry(entry, treeHasDev)) hoisted.delete(owner);
  }
  return hoisted;
}

/**
 * The subset of `emptyDepDirs` that npm hoisted away — i.e. the empty dep dirs
 * an ancestor tree's hidden lockfile proves were reified as links with no
 * dependency tree of their own.
 *
 * Only a dir literally named `node_modules` is eligible: the hoisting rule is
 * npm's, so a declared build output (`dist/`, which docs/183 explicitly invites
 * declaring) is never excused by it. A root-level `node_modules` is never
 * eligible either — it has no ancestor package to hoist into, and it is the dir
 * whose emptiness the docs/272 check exists to catch.
 */
export function hoistedAwayDepDirs(workspaceRoot: string, emptyDepDirs: string[]): string[] {
  // Ancestor dir → the hoisted link targets its own `node_modules` records.
  // Cached so a monorepo declaring N sibling dep dirs reads the root lockfile
  // once.
  const targetsByAncestor = new Map<string, Set<string>>();

  const targetsFor = (ancestor: string): Set<string> => {
    const cached = targetsByAncestor.get(ancestor);
    if (cached) return cached;
    let targets = new Set<string>();
    try {
      const lockPath = path.join(workspaceRoot, ancestor, "node_modules", HIDDEN_LOCKFILE);
      targets = hoistedLinkTargets(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // No hidden lockfile there (or unreadable): that ancestor reified nothing,
      // so it excuses nothing. Never a reason to fail an install either.
    }
    targetsByAncestor.set(ancestor, targets);
    return targets;
  };

  const hoisted: string[] = [];
  for (const depDir of emptyDepDirs) {
    if (path.posix.basename(depDir) !== "node_modules") continue;
    const packageDir = path.posix.dirname(depDir);
    if (packageDir === ".") continue; // The root tree is never hoisted away.

    // Walk outward from the package's own parent to the workspace root: a
    // nested workspace (`packages/web`) may be reified by an intermediate tree
    // or by the root one, and npm's `resolved` is relative to whichever wrote it.
    for (let ancestor = path.posix.dirname(packageDir); ; ancestor = path.posix.dirname(ancestor)) {
      if (targetsFor(ancestor).has(path.posix.relative(ancestor, packageDir))) {
        hoisted.push(depDir);
        break;
      }
      if (ancestor === ".") break;
    }
  }
  return hoisted;
}
