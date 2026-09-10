// Source guard: ownership helpers do nothing without root, masking unsafe call sites in tests.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_SRC = path.join(HERE, "..");
const ROOTS = [HERE, path.join(HERE, "..", "shared")];

function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  out = out
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? "" : line))
    .join("\n");
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const PLAIN_RECURSIVE_CHOWN = /\bchownTreeToSessionWorker\s*\(/g;

const DECLARING_FILE = "orchestrator/session-worker-uid.ts";

const ALLOWED: Record<string, { count: number; why: string }> = {
  "orchestrator/services/github-ci-fix.ts": {
    count: 1,
    why: "The CI-failure log directory under the session's own state dir (docs/246) — "
      + "ShipIt's generated artifacts, a sibling of the clone. No git tree, no object store.",
  },
  "orchestrator/session-credentials-scaffold.ts": {
    count: 1,
    why: "The per-session credentials subtree under `<credentialsDir>/sessions/<id>` — "
      + "written by the orchestrator, mounted at `/credentials`, no git tree. The recursive "
      + "walk is load-bearing here for the opposite reason: it must reach the legacy-alias "
      + "symlinks, which it lchowns in place without following.",
  },
  "orchestrator/session-dir-factory.ts": {
    count: 1,
    why: "A session directory that has just been created and holds nothing yet — "
      + "a handful of lchowns over empty directories, no object store to reach into.",
  },
  "orchestrator/services/session-fork-merge.ts": {
    count: 1,
    why: "The fork's workspace, cloned with `--no-hardlinks` (required there for its own "
      + "reason: the source's objects are root-owned and the clone runs dropped). Nothing "
      + "under it shares an inode with the bare cache or with the source session, so the "
      + "full walk hands nobody rights over anyone else's content — argued in place.",
  },
};

describe("plain recursive chown is a census (docs/272-shared-cache-ownership req 3)", () => {
  it("every chownTreeToSessionWorker call site is listed with why its tree shares no inode", () => {
    const found = new Map<string, number>();
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const rel = path.relative(REPO_SRC, file).split(path.sep).join("/");
      if (rel === DECLARING_FILE) continue;
      const count = [...stripComments(fs.readFileSync(file, "utf-8")).matchAll(PLAIN_RECURSIVE_CHOWN)].length;
      if (count > 0) found.set(rel, count);
    }

    const expected = Object.fromEntries(
      Object.entries(ALLOWED).map(([file, { count }]) => [file, count]),
    );

    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    expect(Object.fromEntries([...found].sort()), [
      "`chownTreeToSessionWorker` is a plain `chownRecursive`: it descends into",
      "`.git/objects` data files. `clone --local` HARDLINKS those from the source",
      "repository and an inode has exactly one owner across every link — so on a tree",
      "cut from a shared cache this hands a SESSION ownership of object files every",
      "sibling session reads (planning#417, observed in production as a per-session",
      "worker uid owning objects inside `repo-cache`).",
      "",
      "Nothing at runtime will tell you: the helper resolves an identity first and",
      "no-ops when there is none, so below root — every test, the dogfood instance —",
      "the call does nothing and any behavioural assertion passes either way.",
      "",
      "If you added one: use `handWorkspaceBackToWorker` (a session workspace) or",
      "`handPluginCheckoutToWorker` (a plugin checkout) instead — both chown object",
      "DIRECTORIES and never object data files. If the tree genuinely shares no inode",
      "with a shared cache, add it here and say why.",
    ].join("\n")).toEqual(expected);
  });

  it("the pattern reads a call, not a mention", () => {
    const hits = (src: string): number => {
      PLAIN_RECURSIVE_CHOWN.lastIndex = 0;
      return [...src.matchAll(PLAIN_RECURSIVE_CHOWN)].length;
    };

    expect(hits("chownTreeToSessionWorker(job.stagingDir);")).toBe(1);
    expect(hits("  chownTreeToSessionWorker (dir)")).toBe(1);
    expect(hits('import { chownTreeToSessionWorker } from "./x.js";')).toBe(0);
    expect(hits("export function chownTreeToSessionWorker")).toBe(0);
  });
});
