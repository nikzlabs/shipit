
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function runHook(payload: unknown, env?: Record<string, string>): { status: number | null; stderr: string } {
  // Isolate test policy from the enclosing ShipIt session's hook settings.
  const {
    SHIPIT_GUARD_DESTRUCTIVE_GIT: _guard,
    SHIPIT_SANDBOX: _sandbox,
    ...ambient
  } = process.env;
  const r = spawnSync("node", [HOOK_SCRIPT], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...ambient, ...env },
  });
  return { status: r.status, stderr: r.stderr };
}

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
      'echo hi && git checkout -b feature/foo',
      "git add -A; git checkout -b feature/foo; git commit -m x",
      "git status | cat && git switch -c feature/foo",
      "GIT_PAGER=cat git checkout -b feature/foo",
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
      "git checkout -- src/index.ts",
      "git checkout src/index.ts",
      "git branch",
      "git branch -a",
      "git branch --list 'feature/*'",
      "git branch -d old-feature",
      "git branch -D old-feature",
      "git branch --delete old-feature",
      "git commit -m 'checkout -b not a real branch'",
      'echo "git checkout -b foo"',
      "git log --oneline",
      "git push",
      "git add -A && git commit -m wip",
      "npm test",
      "git switch",
    ];
    for (const command of allowed) {
      it(`allows: ${command}`, () => {
        const r = runHook(bash(command));
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
      });
    }
  });

  describe("docs/211 — self-gates OFF for a sandbox session (SHIPIT_SANDBOX=1)", () => {
    it("allows a branch-creating command when SHIPIT_SANDBOX=1", () => {
      const r = runHook(bash("git checkout -b feature/foo"), { SHIPIT_SANDBOX: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    });

    it("still blocks when SHIPIT_SANDBOX is unset / not '1'", () => {
      expect(runHook(bash("git switch -c x"), { SHIPIT_SANDBOX: "0" }).status).toBe(2);
      expect(runHook(bash("git switch -c x")).status).toBe(2);
    });
  });

  describe("planning#267 — destructive git while the session sits on a merged branch", () => {
    const guarded = { SHIPIT_GUARD_DESTRUCTIVE_GIT: "1" };

    const blocked = [
      "git reset --hard",
      "git reset --hard origin/main",
      "git reset --hard HEAD~3",
      "git checkout -f",
      "git checkout --force main",
      "git push --force",
      "git push -f origin HEAD",
      "git push --force-with-lease",
      "git push --force-with-lease=refs/heads/x:abc123",
      "git push --force-if-includes --force-with-lease origin HEAD",
      "git rebase origin/main",
      "git rebase",
      "git rebase -i origin/main",
      "git rebase --onto origin/main HEAD~3",
      "git pull --rebase",
      "git pull --rebase origin main",
      "git pull -r",
      "git pull --rebase=merges origin main",
      "git fetch origin && git reset --hard origin/main",
      "git fetch origin && git rebase origin/main",
      "GIT_PAGER=cat git reset --hard origin/main",
      "git -C /workspace reset --hard origin/main",
    ];
    for (const command of blocked) {
      it(`blocks when guarded: ${command}`, () => {
        const r = runHook(bash(command), guarded);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("Blocked:");
        expect(r.stderr).toContain("shipit branch reset-to-base");
      });
    }

    it("leaves the same commands alone outside the guarded state", () => {
      for (const command of blocked) {
        const r = runHook(bash(command));
        expect({ command, status: r.status, stderr: r.stderr }).toEqual({
          command,
          status: 0,
          stderr: "",
        });
      }
    });

    it("does not arm on a value other than '1'", () => {
      expect(runHook(bash("git reset --hard"), { SHIPIT_GUARD_DESTRUCTIVE_GIT: "0" }).status).toBe(0);
      expect(runHook(bash("git reset --hard"), { SHIPIT_GUARD_DESTRUCTIVE_GIT: "true" }).status).toBe(0);
    });

    it("docs/211 — stays off for a sandbox session even when armed", () => {
      const r = runHook(bash("git reset --hard origin/main"), {
        ...guarded,
        SHIPIT_SANDBOX: "1",
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    });

    describe("allows non-destructive git even when guarded", () => {
      const allowed = [
        "shipit branch reset-to-base",
        "shipit branch reset-to-base && npm test",
        'shipit branch reset-to-base --force --reason "content shipped via cherry-pick"',
        "git fetch origin && shipit branch reset-to-base --force --reason 'stranded'",
        "git reset",
        "git reset --soft HEAD~1",
        "git reset HEAD -- src/index.ts",
        "git checkout -- src/index.ts",
        "git checkout src/index.ts",
        "git rebase --continue",
        "git rebase --abort",
        "git rebase --skip",
        "git rebase --quit",
        "git rebase --help",
        "git pull",
        "git pull origin main",
        "git push",
        "git push origin HEAD",
        "git fetch origin",
        "git status",
        "git log --oneline",
        "git commit -m 'git reset --hard in a message'",
        'echo "git reset --hard"',
        "npm test -- --force",
      ];
      for (const command of allowed) {
        it(`allows: ${command}`, () => {
          const r = runHook(bash(command), guarded);
          expect(r.status).toBe(0);
          expect(r.stderr).toBe("");
        });
      }
    });

    it("still blocks branch ops with the branch-op message, not the reset one", () => {
      const r = runHook(bash("git checkout -b feature/foo"), guarded);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("dedicated branch");
      expect(r.stderr).not.toContain("shipit branch reset-to-base");
    });
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
