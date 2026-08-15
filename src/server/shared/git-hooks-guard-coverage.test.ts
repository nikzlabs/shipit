/**
 * planning#384 — the guard has to hold for git spawns nobody has written yet.
 *
 * `git-hooks-guard.test.ts` proves the mechanism works. This proves it is
 * *applied everywhere*, by scanning the orchestrator's own source for processes
 * named `git` and failing when one is spawned without
 * `gitArgsWithHooksDisabled`.
 *
 * It exists because the obvious way to cover future call sites — installing
 * git's `GIT_CONFIG_COUNT` env protocol once on the orchestrator process — was
 * tried and rejected: simple-git's `blockUnsafeOperationsPlugin` inspects the
 * environment and refuses to spawn at all when it sees `GIT_CONFIG_COUNT`, and
 * suppressing that would switch off its protection against inherited config
 * injection generally (see `git-hooks-guard.ts`). A source scan buys the same
 * property and fails at CI instead of at runtime.
 *
 * The simple-git half of the same problem is covered by ESLint
 * (`no-restricted-imports` on the `simple-git` default export), which is why
 * this only looks at raw process spawns.
 *
 * Scope is deliberately the ORCHESTRATOR (plus the `shared/` code it runs).
 * Session-container code is excluded: git inside the session container runs the
 * project's hooks on purpose — the agent is already inside the trust boundary,
 * and a repo's own `pre-commit` formatter firing when the agent commits is what
 * a user expects.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.join(HERE, "..", "orchestrator"), HERE];

/**
 * A `git` process being started: `spawn("git", …)`, `execFile("git", …)`,
 * `execFileSync("git", …)`, `execFileAsync("git", …)`, and the same with the
 * argument list on the following line. Captures whatever follows the comma so
 * the assertion can look for the wrapper.
 */
const GIT_SPAWN = /\b(?:spawn|execFile|execFileSync|execFileAsync)\s*\(\s*\n?\s*"git"\s*,\s*\n?\s*([^\n]*)/g;

/**
 * Drop comment lines before scanning. Docstrings in this very feature quote the
 * `spawn("git", …)` shape they are describing, and a scanner that reads prose as
 * code fails on documentation — which trains people to weaken the scanner.
 * Blanking rather than deleting keeps reported line numbers correct.
 */
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
      // Test helpers spin up throwaway fixture repos of their own; they are not
      // the orchestrator operating on a workspace a plugin can write.
      if (entry.name === "integration_tests" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("git hooks guard: coverage of raw git spawns", () => {
  it("every orchestrator-side `git` process spawn goes through gitArgsWithHooksDisabled", () => {
    const unguarded: string[] = [];
    let checked = 0;

    for (const file of ROOTS.flatMap(sourceFiles)) {
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      for (const match of src.matchAll(GIT_SPAWN)) {
        checked++;
        if (match[1].includes("gitArgsWithHooksDisabled")) continue;
        const line = src.slice(0, match.index).split("\n").length;
        unguarded.push(`${path.relative(path.join(HERE, "..", ".."), file)}:${line} — ${match[0].trim()}`);
      }
    }

    // If this drops to zero the regex has stopped matching anything and the
    // test would pass vacuously — the failure mode that makes a guard test
    // worthless. Fail instead.
    expect(checked).toBeGreaterThan(5);

    expect(unguarded, [
      "These spawn a `git` process without disabling repository hooks.",
      "The orchestrator is root and mounts the credential store and the Docker socket,",
      "and a session workspace is writable by untrusted plugin containers (planning#384).",
      "Wrap the argument list: execFileSync(\"git\", gitArgsWithHooksDisabled([...])).",
    ].join("\n")).toEqual([]);
  });
});
