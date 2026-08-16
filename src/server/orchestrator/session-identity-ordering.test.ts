/**
 * docs/268 — three orderings that cannot be exercised without root, guarded by
 * reading the source.
 *
 * A source scan is the weakest kind of test and this file only exists because
 * the alternative is nothing. Each property below decides whether an
 * unprivileged git can write the tree it was pointed at, and reproducing it
 * needs a real uid drop against a foreign-owned directory — which a session
 * container cannot produce (no root, `unshare -r` refused). A functional test
 * written anyway would pass with the ordering reversed, which is worse than an
 * honest source assertion. The precedent is
 * `shared/git-hooks-guard-coverage.test.ts`, which fails CI on a property it
 * likewise cannot run.
 *
 * What these CANNOT catch, stated so nobody reads them as more than they are:
 * a reorder that keeps the textual order but changes the runtime order (an
 * `await` moved, a call hoisted into a helper, a branch that skips the handoff),
 * and any failure of the handoff itself.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return fs.readFileSync(path.join(HERE, rel), "utf8");
}

/**
 * The body of `functionName`, from its signature to the next top-level `}`,
 * with comment lines stripped.
 *
 * Stripping is not cosmetic: these comments EXPLAIN the ordering, so they name
 * the very calls the assertions look for, and a scan over the raw text finds the
 * explanation rather than the code. The first version of this file failed
 * exactly that way.
 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found — this guard is anchored on it`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return stripComments(source.slice(start, end));
}

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")
      && !line.trim().startsWith("/*"))
    .join("\n");
}

describe("docs/268 — orderings a uid drop depends on", () => {
  it("cloneFromCache hands the tree over BEFORE it runs git in it", () => {
    // `safeSimpleGit(sessionDir)` drops to the session's own uid. Run against a
    // tree `git clone --local` just created as root, it EACCESes writing
    // `.git/config` and session creation fails. This held only by accident
    // before docs/268: a root-owned tree meant "do not drop", which stopped
    // being true once the session DIRECTORY became the record instead of the
    // tree.
    const body = bodyOf(read("repo-git.ts"), "async cloneFromCache(");
    const handback = body.indexOf("handWorkspaceBackToWorker(");
    const droppedGit = body.indexOf("safeSimpleGit(sessionDir)");
    expect(handback).toBeGreaterThan(-1);
    expect(droppedGit).toBeGreaterThan(-1);
    expect(handback).toBeLessThan(droppedGit);
  });

  it("cloneFromCache uses the object-aware handback, not a plain recursive chown", () => {
    // `git clone --local` HARDLINKS `.git/objects` from the shared bare cache,
    // and an inode has one owner across every link — so a plain recursive chown
    // hands this session chmod and rewrite rights over object files the cache
    // and every sibling clone read. `handWorkspaceBackToWorker` composes the
    // walk that chowns object DIRECTORIES but never object FILES.
    const body = bodyOf(read("repo-git.ts"), "async cloneFromCache(");
    expect(body).toContain("handWorkspaceBackToWorker(");
    expect(body).not.toContain("chownTreeToSessionWorker(");
  });

  it("the session directory is sealed before anything is written into it", () => {
    // The seal is what makes every later chown and every dropped git resolve to
    // the allocated uid. Anything written before it resolves to the shared
    // global value instead, leaving a session whose record and whose contents
    // disagree.
    const source = stripComments(read("session-dir-factory.ts"));
    const seal = source.indexOf("sealSessionDir(");
    const track = source.indexOf("sessionManager.track(");
    expect(seal).toBeGreaterThan(-1);
    expect(track).toBeGreaterThan(seal);
  });

  it("the identity roots are configured before the legacy seal runs", () => {
    // `sealLegacySessionDirs` is harmless out of order, but everything that
    // chowns afterwards asks the resolver whose a path is — and an unconfigured
    // resolver answers "nobody", which silently reinstates the single-uid
    // behaviour this feature exists to end.
    const source = stripComments(read("index.ts"));
    const configure = source.indexOf("configureSessionIdentityRoots(");
    const seal = source.indexOf("sealLegacySessionDirs(");
    expect(configure).toBeGreaterThan(-1);
    expect(seal).toBeGreaterThan(configure);
  });
});
