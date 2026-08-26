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
 * npm already records the answer, across the two lockfiles beside an ancestor
 * package. **All three conditions below are load-bearing**, and each was added
 * because dropping it produced a real hole:
 *
 *  1. The **hidden** lockfile (`node_modules/.package-lock.json`, npm's record
 *     of what it actually reified) holds a **link** entry for the target:
 *     `{ "resolved": "server", "link": true }`. This proves the install ran and
 *     covered this workspace.
 *  2. The **hidden** lockfile holds **no entry at all** under that target's own
 *     `node_modules/` (`server/node_modules/lodash`). npm writes such an entry
 *     when a dependency could not hoist — verified against npm 10 and 11, a root
 *     on `lodash@4` with a workspace `server` on `lodash@3` produces BOTH the
 *     link and `server/node_modules/lodash@3.10.1`, and creates the directory on
 *     disk. So condition 1 alone proves nothing about the workspace's own dep
 *     dir.
 *  3. The **manifest** lockfile (`package-lock.json`) holds no entry under that
 *     target's `node_modules/` either.
 *
 * **Condition 2 is unfiltered, deliberately.** The hidden lockfile lists ONLY
 * what npm put on disk — verified: an optional dependency skipped for a platform
 * mismatch is absent from it entirely, while the manifest lockfile still lists it
 * with `optional: true, os: ["darwin"]`. So every entry present under a target
 * means a real directory. An earlier cut filtered these through the staleness
 * check's `isRequired`, which is built for the MANIFEST side where non-installed
 * packages do appear; pointed at the hidden lockfile those exclusions silently
 * ignore packages that ARE on disk. This repository's own hidden lockfile has 21
 * such entries (`@esbuild/linux-x64`, `@testing-library/dom`, …).
 *
 * **Condition 3 is what stops a STALE record from laundering an install.** The
 * hidden lockfile lives in an ancestor tree that may not itself be a declared dep
 * dir, in which case no other check covers it and nothing proves it describes the
 * install that just ran. Consider a repo declaring only `server/node_modules`: an
 * older commit's root install recorded the link with everything hoisted; a newer
 * commit adds a conflicting `server` dependency; the install launders a failure
 * and leaves the mount point empty. The stale root record still says "linked, no
 * nested tree". The manifest lockfile cannot drift that way — it is a COMMITTED
 * file, current with the checkout by construction — and for that repo it holds
 * `server/node_modules/lodash`, so the exemption is refused and the install fails
 * as it should. A missing manifest lockfile is therefore also a refusal: without
 * it there is no current statement to check the record against.
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
import { HIDDEN_LOCKFILE, NPM_LOCKFILE, parsePackages } from "./dep-tree-staleness.js";

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
 * The package paths whose dependencies npm hoisted away entirely — linked in the
 * HIDDEN lockfile, and named by neither lockfile as owning a nested tree.
 *
 * See the module doc for why all three conditions are needed. Pure (takes both
 * texts) so the whole rule is unit-testable without a filesystem. An
 * unparseable, non-v2+, or missing manifest lockfile yields an empty set — the
 * direction that exempts nothing, never the direction that exempts everything.
 */
export function hoistedLinkTargets(
  hiddenLockfileText: string,
  manifestLockfileText: string,
): Set<string> {
  const installed = parsePackages(hiddenLockfileText);
  const manifest = parsePackages(manifestLockfileText);
  if (installed === null || manifest === null) return new Set();

  // Condition 1 — npm reified this package as a link, so the install covered it.
  const hoisted = new Set<string>();
  for (const entry of Object.values(installed)) {
    if (typeof entry !== "object" || entry === null) continue;
    const resolved: unknown = entry.resolved;
    if (entry.link !== true || typeof resolved !== "string") continue;
    const normalized = normalizeLinkTarget(resolved);
    if (normalized) hoisted.add(normalized);
  }
  if (hoisted.size === 0) return hoisted;

  // Conditions 2 and 3 — drop every target either lockfile says owns a nested
  // tree. Unfiltered on purpose (module doc): the hidden lockfile lists only what
  // is on disk, and the manifest side is consulted for the CURRENT commit's
  // intent, which a stale hidden lockfile cannot express.
  //
  // Matched by PREFIX against each candidate rather than by splitting keys on
  // their first `/node_modules/` and attributing the result. Splitting is subtly
  // wrong for a target whose own path contains a `node_modules` segment — the
  // config parser permits `packages/node_modules/server`, and a `file:` link can
  // resolve to one — where the first boundary names an ancestor instead of the
  // target, and the target is then wrongly kept. Prefix matching cannot
  // misattribute, and the candidate set is a handful of workspaces.
  const keys = [...Object.keys(installed), ...Object.keys(manifest)];
  for (const target of [...hoisted]) {
    const prefix = `${target}/node_modules/`;
    if (keys.some((key) => key.startsWith(prefix))) hoisted.delete(target);
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
      const dir = path.join(workspaceRoot, ancestor);
      targets = hoistedLinkTargets(
        fs.readFileSync(path.join(dir, "node_modules", HIDDEN_LOCKFILE), "utf8"),
        fs.readFileSync(path.join(dir, NPM_LOCKFILE), "utf8"),
      );
    } catch {
      // Either lockfile absent or unreadable: that ancestor reified nothing this
      // module can vouch for, so it excuses nothing. Never a reason to FAIL an
      // install either — the caller only ever drops entries from a list.
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
