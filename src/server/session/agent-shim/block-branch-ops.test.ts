/**
 * Tests for docker/agent-hooks/block-branch-ops.mjs — the Claude Code
 * PreToolUse hook that keeps the agent on the session's dedicated branch.
 *
 * Strategy: run the real script with `node`, feeding it the JSON envelope
 * Claude Code passes on stdin. We assert exit codes (0 = allow, 2 = block)
 * and that the block reason reaches stderr.
 *
 * The hook is a pure stdin→exit-code function — no git repo or filesystem
 * needed — so these tests are fast and hermetic.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test lives next to gh.ts so vitest's src/server/** glob picks it up, but the
// hook script ships from docker/agent-hooks/ (baked into the session-worker
// image and run by the Claude CLI inside containers).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "docker",
  "agent-hooks",
  "block-branch-ops.mjs",
);

function runHook(payload: unknown): { status: number | null; stderr: string } {
  const r = spawnSync("node", [HOOK_SCRIPT], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}

/** Build a Bash-tool PreToolUse envelope for `command`. */
function bash(command: string) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

describe("block-branch-ops.mjs", () => {
  describe("blocks branch-creating / branch-switching commands", () => {
    const blocked = [
      "git checkout -b feature/foo",
      "git checkout -B feature/foo",
      "git switch -c feature/foo",
      "git switch -C feature/foo",
      "git switch --create feature/foo",
      "git switch --orphan empty",
      "git switch main",
      "git branch feature/foo",
      "git branch -f feature/foo origin/main",
      "git worktree add ../wt -b feature/foo",
      // Buried in a compound command.
      'echo hi && git checkout -b feature/foo',
      "git add -A; git checkout -b feature/foo; git commit -m x",
      "git status | cat && git switch -c feature/foo",
      // Leading env assignment before git.
      "GIT_PAGER=cat git checkout -b feature/foo",
      // git global options before the subcommand.
      "git -C /workspace checkout -b feature/foo",
    ];
    for (const command of blocked) {
      it(`blocks: ${command}`, () => {
        const r = runHook(bash(command));
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("Blocked:");
        expect(r.stderr).toContain("dedicated branch");
      });
    }
  });

  describe("allows everything else", () => {
    const allowed = [
      "git status",
      "git checkout -- src/index.ts", // discard file changes
      "git checkout src/index.ts",
      "git branch", // list
      "git branch -a",
      "git branch --list 'feature/*'",
      "git branch -d old-feature", // delete is fine
      "git branch -D old-feature",
      "git branch --delete old-feature",
      "git commit -m 'checkout -b not a real branch'", // string arg, not a flag
      'echo "git checkout -b foo"', // not actually invoking git
      "git log --oneline",
      "git push",
      "git add -A && git commit -m wip",
      "npm test",
      "git switch", // no-op (errors in real git), nothing to block
    ];
    for (const command of allowed) {
      it(`allows: ${command}`, () => {
        const r = runHook(bash(command));
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
      });
    }
  });

  describe("fails open on non-Bash / malformed input", () => {
    it("allows non-Bash tools", () => {
      const r = runHook({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/x", old_string: "git checkout -b", new_string: "" },
      });
      expect(r.status).toBe(0);
    });

    it("allows an empty Bash command", () => {
      expect(runHook(bash("")).status).toBe(0);
      expect(runHook(bash("   ")).status).toBe(0);
    });

    it("allows when stdin is not valid JSON", () => {
      expect(runHook("not json").status).toBe(0);
    });

    it("allows when the envelope has no command", () => {
      expect(
        runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }).status,
      ).toBe(0);
    });
  });
});
