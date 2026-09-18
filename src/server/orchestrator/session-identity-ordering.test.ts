// Source-order guards cannot prove runtime order or successful uid handoff.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return fs.readFileSync(path.join(HERE, rel), "utf8");
}

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

describe("docs/270 — orderings a uid drop depends on", () => {
  it("cloneFromCache hands the tree over BEFORE it runs git in it", () => {
    const body = bodyOf(read("repo-git.ts"), "async cloneFromCache(");
    const handback = body.indexOf("handWorkspaceBackToWorker(");
    const droppedGit = body.indexOf("safeSimpleGit(sessionDir)");
    expect(handback).toBeGreaterThan(-1);
    expect(droppedGit).toBeGreaterThan(-1);
    expect(handback).toBeLessThan(droppedGit);
  });

  it("cloneFromCache uses the object-aware handback, not a plain recursive chown", () => {
    const body = bodyOf(read("repo-git.ts"), "async cloneFromCache(");
    expect(body).toContain("handWorkspaceBackToWorker(");
    expect(body).not.toContain("chownTreeToSessionWorker(");
  });

  it("no orchestrator path chowns a session WORKSPACE with the object-blind walk", () => {
    // Forks use --no-hardlinks, so changing object ownership cannot affect the source.
    const EXEMPT = "services/session-fork-merge.ts";
    const dir = HERE;
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          if (path.relative(HERE, full) === EXEMPT) continue;
          for (const line of stripComments(fs.readFileSync(full, "utf8")).split("\n")) {
            if (!line.includes("chownTreeToSessionWorker(")) continue;
            if (/chownTreeToSessionWorker\(\s*[\w.]*[Ww]orkspaceDir/.test(line)) {
              offenders.push(`${path.relative(HERE, full)}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });

  it("the fork clone passes --no-hardlinks, or it cannot run at all", () => {
    const source = stripComments(read("services/session-fork-merge.ts"));
    const clone = source.slice(source.indexOf('"clone"'));
    expect(clone.slice(0, clone.indexOf("]"))).toContain('"--no-hardlinks"');
  });

  it("every path that creates a session directory seals it", () => {
    for (const file of ["session-dir-factory.ts", "services/session-fork-merge.ts"]) {
      const source = stripComments(read(file));
      expect(source, `${file} creates a session dir without sealing it`)
        .toContain("allocateAndSealSessionDir(");
    }
  });

  it("the fork seals and hands over before it runs git in the new clone", () => {
    const source = stripComments(read("services/session-fork-merge.ts"));
    const seal = source.indexOf("allocateAndSealSessionDir(");
    const handback = source.indexOf("chownTreeToSessionWorker(newWorkspaceDir)");
    const droppedGit = source.indexOf("safeSimpleGit(newWorkspaceDir)");
    expect(seal).toBeGreaterThan(-1);
    expect(handback).toBeGreaterThan(seal);
    expect(droppedGit).toBeGreaterThan(handback);
  });

  it("the identity roots are configured before the legacy seal runs", () => {
    const source = stripComments(read("index.ts"));
    const configure = source.indexOf("configureSessionIdentityRoots(");
    const seal = source.indexOf("sealLegacySessionDirs(");
    expect(configure).toBeGreaterThan(-1);
    expect(seal).toBeGreaterThan(configure);
  });
});
