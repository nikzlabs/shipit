
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

  /**
   * A wait loop whose own `pgrep -f` test can only be true. The Bash tool runs
   * a command as `bash -c '<the whole command>'`, so the pattern is part of the
   * command line the test is searching.
   */
  describe("refuses a wait loop whose process test matches its own command line", () => {
    const JOB = "some_job_name";
    const blocked = [
      // The incident, verbatim.
      'until ! pgrep -f "vitest run src/server/orchestrator/services/" >/dev/null 2>&1; do sleep 3; done; tail -6 /tmp/out.log',
      'while pgrep -f "npm run build" > /dev/null; do sleep 2; done',
      `until ! pgrep -af '${JOB}'; do sleep 1; done`,
      // `pkill -f` never signals itself, but it does signal the shell running it.
      `until ! pkill -f "${JOB}"; do sleep 1; done`,
      `until ! /usr/bin/pgrep -f ${JOB}; do sleep 1; done`,
      `until ! pgrep --full "${JOB}"; do sleep 1; done`,
      `(until ! pgrep -f ${JOB}; do sleep 1; done) && echo ok`,
      `echo "x"; until ! pgrep -f ${JOB}; do sleep 1; done`,
      // A quoted operand is an operand: a pattern opening with `(` is not the
      // shell's subshell syntax, and reading it as such let a real one through.
      `while pgrep -f '(${JOB}|second_job)' >/dev/null; do sleep 1; done`,
      // Quoting a command NAME does not stop it running — bash runs `"echo" x`
      // — even though quoting a keyword does stop it being one.
      `until ! "pgrep" -f ${JOB}; do sleep 1; done`,
    ];
    for (const command of blocked) {
      it(`blocks: ${command.slice(0, 58)}`, () => {
        const r = runHook(bash(command));
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("Blocked:");
        expect(r.stderr).toContain("matches ITSELF");
      });
    }

    it("keeps reading after a pattern it cannot parse, rather than stopping there", () => {
      // Two loops: the first pattern is not a regex this runtime reads, the
      // second matches itself. Giving up at the first would let the second run.
      const r = runHook(
        bash('until ! pgrep -f "bad[" ; do sleep 1; done; until ! pgrep -f "my-job"; do sleep 1; done'),
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("`my-job`");
    });

    it("names the pattern and the ways out, so the refusal is actionable", () => {
      const r = runHook(bash('until ! pgrep -f "my-job"; do sleep 1; done'));
      expect(r.stderr).toContain("`my-job`");
      expect(r.stderr).toContain("background mode notifies you");
      expect(r.stderr).toContain("Wait on the artifact");
      // Both escapes it names must be escapes this hook actually leaves alone.
      expect(r.stderr).toContain("pgrep -A");
      expect(r.stderr).toContain("[v]itest");
    });

    it("applies to a sandbox session, whose branch exemption is not about this", () => {
      // docs/211 exempts a sandbox because it owns its branch. A loop whose
      // test cannot change hangs a sandbox session exactly as it hangs any other.
      const loop = 'until ! pgrep -f "my-job"; do sleep 1; done';
      expect(runHook(bash(loop), { SHIPIT_SANDBOX: "1" }).status).toBe(2);
      expect(runHook(bash("git checkout -b feature/foo"), { SHIPIT_SANDBOX: "1" }).status).toBe(0);
    });
  });

  describe("leaves alone what it cannot call broken", () => {
    const JOB = "some_job_name";
    const allowed = [
      // Excluding yourself is the correct way to write this, so each of these
      // must pass — `-A` drops this shell's ancestors, `-P` keeps only its
      // children, `-x` demands the whole command line, `-v` inverts the test,
      // and a uid filter scopes it away. Refusing the fix would be the worst
      // outcome available.
      `while pgrep -Af ${JOB} >/dev/null; do sleep 1; done`,
      `while pgrep -P "$$" -f ${JOB} >/dev/null; do sleep 1; done`,
      `while pgrep -fx ${JOB} >/dev/null; do sleep 1; done`,
      `until ! pgrep -vf ${JOB}; do sleep 1; done`,
      `until ! pgrep -u root -f ${JOB}; do sleep 1; done`,
      // Code as data runs nothing. Quoting and heredoc bodies are the line.
      `printf '%s\n' 'while pgrep -f ${JOB}; do sleep 1; done'`,
      `echo "until ! pgrep -f ${JOB}; do sleep 1; done"`,
      `cat <<'EOF'\nwhile pgrep -f ${JOB}; do sleep 1; done\nEOF`,
      `python3 - <<'PY'\nprint("while pgrep -f ${JOB}; do sleep 1; done")\nPY`,
      // The other fix the refusal recommends: a pattern that cannot match its
      // own literal. The check is a regex and not a substring test precisely so
      // this works.
      'until ! pgrep -f "[v]itest run src/server/orchestrator/services/"; do sleep 3; done',
      // Measured against the real pgrep: an alternation group does not match
      // its own literal, so this looks for `npm run` / `npm test`, neither of
      // which is in this command.
      'until ! pgrep -f "npm (run|test)"; do sleep 1; done',
      // Nothing literal to match: the pattern is not known until it runs.
      `PAT=vitest; until ! pgrep -f "$PAT"; do sleep 1; done`,
      // Listing processes to read them is not a loop, and matching itself there
      // costs one extra line of output.
      'pgrep -af "vitest|tsc --noEmit|eslint"',
      // The shape the refusal recommends instead.
      "until grep -qE '^(PASS|FAIL)' /tmp/out.log; do sleep 5; done",
      "until [ -f /tmp/done ]; do sleep 1; done",
      "npm test",
      // Without -f, pgrep matches a process NAME and never a command line, so
      // the pattern being in this command means nothing.
      `until ! pgrep ${JOB}; do sleep 1; done`,
      // pgrep takes exactly one pattern. Two operands is a command it would
      // reject itself, and picking one of them would be a guess.
      `until ! pgrep -f ${JOB} second_operand; do sleep 1; done`,
      // A quoted keyword is not a keyword: bash refuses `wh"ile" x; do y; done`
      // outright, so this is not a loop and nothing here judges it as one.
      `wh"ile" pgrep -f ${JOB}; do sleep 1; done`,
      // Shapes this cannot read, where a guess would refuse correct work: an
      // option it does not know, quoting that never closes, and a pattern the
      // runtime does not read as a regex.
      `until ! pgrep --future-flag val -f ${JOB}; do sleep 1; done`,
      `until ! pgrep -f "${JOB}; do sleep 1; done`,
      `until ! pgrep -f "${JOB}[" ; do sleep 1; done`,
    ];
    for (const command of allowed) {
      it(`allows: ${command.replace(/\n/g, " ").slice(0, 58)}`, () => {
        const r = runHook(bash(command));
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
      });
    }

    it("gives up on a pattern that backtracks, instead of stalling the hook", () => {
      // `a(a+)+$` over 26 characters takes seconds in this runtime and a `try`
      // cannot interrupt it. A hook that stalls is the failure this one exists
      // to prevent, so the match runs under a deadline it is allowed to lose.
      const command = `until ! pgrep -f "a(a+)+$"; do sleep 1; done # ${"a".repeat(26)}!`;
      const started = Date.now();
      const r = runHook(bash(command));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(r.status).toBe(0);
    });
  });
});
