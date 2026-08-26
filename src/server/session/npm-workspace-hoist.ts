/**
 * Which declared dep dirs are empty because npm HOISTED their package's
 * dependencies into an ancestor's `node_modules`? (planning#480.)
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
 * npm already records the answer. When npm reifies a workspace it writes a link
 * entry into the hidden lockfile of the tree it hoisted into — verified against
 * npm 10, `node_modules/.package-lock.json` holds
 * `"node_modules/@scope/server": { "resolved": "server", "link": true }` — and
 * `resolved` is the workspace's path relative to that tree's project root. That
 * entry is positive, install-written evidence of exactly the claim being made:
 * *this* install reified *this* workspace, and put its dependencies elsewhere.
 * An empty `server/node_modules` beside it is the correct outcome, not a failure.
 *
 * ## Why this cannot weaken the checks it sits inside
 *
 * Every exemption requires a hidden lockfile in an ANCESTOR dep tree, which only
 * exists when that tree is populated and npm itself wrote it moments ago:
 *
 *  - **A laundered install exit** (docs/272's field case) leaves the root tree
 *    empty, so there is no hidden lockfile to read and nothing is exempted. A
 *    repo declaring a single dep dir is never exempted at all — a root-level
 *    `node_modules` has no ancestor package to be hoisted into.
 *  - **A freshly-enabled overlay** (docs/183 mode 1) mounts an empty overlay at
 *    every declared dep dir including the root one, so the root still
 *    contradicts and the install still re-runs.
 *  - **A rolled-back flag** (docs/183 mode 2) leaves the same empty mount points
 *    behind, with the same result.
 *  - **Publishing an empty shared base** is refused independently, at
 *    `overlay-publish.ts:240` (`skipped-empty`), so an exempted empty dir cannot
 *    become a scope's rolling base by this route either.
 *
 * Cost: at most one `readFileSync` + `JSON.parse` per ancestor directory, and
 * only for dep dirs already found empty. Never a tree walk.
 */

import fs from "node:fs";
import path from "node:path";
import { HIDDEN_LOCKFILE } from "./dep-tree-staleness.js";

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
 * The workspace paths an npm lockfile records as LINKS — the packages whose
 * dependencies npm hoisted into the tree this lockfile describes.
 *
 * Pure (takes the text) so the whole rule is unit-testable without a filesystem.
 * Anything unparseable, non-v2+, or otherwise not a `packages` map yields an
 * empty set — the direction that exempts nothing, never the direction that
 * exempts everything.
 */
export function workspaceLinkTargets(lockfileText: string): Set<string> {
  const targets = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockfileText);
  } catch {
    return targets;
  }
  if (typeof parsed !== "object" || parsed === null) return targets;
  const packages = (parsed as { packages?: unknown }).packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) return targets;

  for (const entry of Object.values(packages as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { link, resolved } = entry as { link?: unknown; resolved?: unknown };
    if (link !== true || typeof resolved !== "string") continue;
    const normalized = normalizeLinkTarget(resolved);
    if (normalized) targets.add(normalized);
  }
  return targets;
}

/**
 * The subset of `emptyDepDirs` that npm hoisted away — i.e. the empty dep dirs
 * an ancestor tree's hidden lockfile proves were reified as workspace links.
 *
 * Only a dir literally named `node_modules` is eligible: the hoisting rule is
 * npm's, so a declared build output (`dist/`, which docs/183 explicitly invites
 * declaring) is never excused by it. A root-level `node_modules` is never
 * eligible either — it has no ancestor package to hoist into, and it is the dir
 * whose emptiness the docs/272 check exists to catch.
 */
export function hoistedAwayDepDirs(workspaceRoot: string, emptyDepDirs: string[]): string[] {
  // Ancestor dir → the link targets its own `node_modules` records. Cached so a
  // monorepo declaring N sibling dep dirs reads the root lockfile once.
  const linkTargetsByAncestor = new Map<string, Set<string>>();

  const targetsFor = (ancestor: string): Set<string> => {
    const cached = linkTargetsByAncestor.get(ancestor);
    if (cached) return cached;
    let targets = new Set<string>();
    try {
      const lockPath = path.join(workspaceRoot, ancestor, "node_modules", HIDDEN_LOCKFILE);
      targets = workspaceLinkTargets(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // No hidden lockfile there (or unreadable): that ancestor reified nothing,
      // so it excuses nothing. Never a reason to fail an install either.
    }
    linkTargetsByAncestor.set(ancestor, targets);
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
