import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("generateSessionName", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("invokes the local Claude CLI and parses the output", async () => {
    vi.doMock("node:child_process", () => {
      return {
        execFile: (
          file: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          expect(file).toBe("claude");
          expect(args).toContain("-p");
          expect(args).toContain("--output-format");
          expect(args).toContain("text");
          setImmediate(() => {
            cb(null, '{"slug": "add-login", "title": "Add Login Page"}\n', "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("Add a login page", "claude");
    expect(result).toEqual({ slug: "add-login", title: "Add Login Page" });
  });

  // docs/150 — naming is a real provider call and must be billed to a real
  // account. Forcing HOME=/root sent it through the legacy alias symlink to the
  // *migrated default* account regardless of which account was primary, and
  // broke outright once that account was disconnected.
  it("runs the CLI with HOME at the account credential root when given one", async () => {
    let seenHome: string | undefined;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        seenHome = opts.env?.HOME;
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", "claude", "/credentials/provider-accounts/claude/acct_work");

    expect(seenHome).toBe("/credentials/provider-accounts/claude/acct_work");
  });

  it("falls back to the singleton root when no account root is given", async () => {
    let seenHome: string | undefined;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        seenHome = opts.env?.HOME;
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", "claude");

    // A reserved route (API key / env OAuth) has no account root, and the
    // singleton path is what those legitimately use.
    expect(seenHome).toBe(process.env.HOME ?? "/root");
  });

  it("invokes the local Codex CLI when the session uses Codex", async () => {
    vi.doMock("node:child_process", () => {
      return {
        execFile: (
          file: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          expect(file).toBe("codex");
          expect(args[0]).toBe("exec");
          expect(args).toContain("--skip-git-repo-check");
          expect(args[args.length - 1]).toContain("Add a login page");
          setImmediate(() => {
            cb(null, '{"slug": "add-login", "title": "Add Login Page"}\n', "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("Add a login page", "codex");
    expect(result).toEqual({ slug: "add-login", title: "Add Login Page" });
  });

  it("returns null when the CLI exits with an error", async () => {
    vi.doMock("node:child_process", () => {
      return {
        execFile: (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          setImmediate(() => {
            cb(new Error("claude: command failed"), "", "auth error");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("hello", "claude");
    expect(result).toBeNull();
  });

  it("returns null when CLI output has no JSON", async () => {
    vi.doMock("node:child_process", () => {
      return {
        execFile: (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          setImmediate(() => {
            cb(null, "I don't know what you want\n", "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("hello", "claude");
    expect(result).toBeNull();
  });

  it("trims slug to lowercase alphanumerics + hyphens, max 40 chars", async () => {
    vi.doMock("node:child_process", () => {
      return {
        execFile: (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          setImmediate(() => {
            cb(
              null,
              '{"slug": "Add Login!!! With Special@Chars-And-A-Very-Long-Name-That-Exceeds-Forty-Characters", "title": "Login"}\n',
              "",
            );
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("x", "claude");
    expect(result?.slug.length).toBeLessThanOrEqual(40);
    expect(result?.slug).toMatch(/^[a-z0-9-]+$/);
  });

  // Naming is one of the two `codex` processes that start against the
  // same config root on a session's first message; the other is the turn's own
  // agent. Codex's first-run initialization of that root is not
  // concurrency-safe, so the loser exits 1 having done nothing. The gate has to
  // be awaited BEFORE the spawn, or naming is still in the root while it's cold.
  it("initializes a cold Codex config root before spawning the naming CLI", async () => {
    const order: string[] = [];
    vi.doMock("./agents/codex/home-init.js", () => ({
      ensureCodexHomeInitialized: (home: string) => {
        order.push(`gate:${home}`);
        return Promise.resolve();
      },
    }));
    vi.doMock("node:child_process", () => ({
      execFile: (
        file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        order.push(`spawn:${file}`);
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", "codex", "/credentials/provider-accounts/codex/acct_work");

    expect(order).toEqual([
      "gate:/credentials/provider-accounts/codex/acct_work/.codex",
      "spawn:codex",
    ]);
    vi.doUnmock("./agents/codex/home-init.js");
  });

  it("does not gate Claude naming on the Codex root", async () => {
    const gated: string[] = [];
    vi.doMock("./agents/codex/home-init.js", () => ({
      ensureCodexHomeInitialized: (home: string) => {
        gated.push(home);
        return Promise.resolve();
      },
    }));
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", "claude", "/credentials/provider-accounts/claude/acct_work");

    expect(gated).toEqual([]);
    vi.doUnmock("./agents/codex/home-init.js");
  });

  it("clamps title to 60 chars", async () => {
    vi.doMock("node:child_process", () => {
      return {
        execFile: (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          const longTitle = "A".repeat(120);
          setImmediate(() => {
            cb(null, `{"slug": "ok", "title": "${longTitle}"}\n`, "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("x", "claude");
    expect(result?.title.length).toBeLessThanOrEqual(60);
  });
  // docs/252 phase 9 (req 14) — naming runs on the ORCHESTRATOR's own CLIs, so a
  // deployment that did not install this harness has nothing to shell out to.
  it("skips naming for a harness this deployment did not install", async () => {
    let spawned = false;
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id !== "claude",
      readInstalledHarnesses: () => ["codex"],
    }));
    vi.doMock("node:child_process", () => ({
      execFile: () => {
        spawned = true;
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("hi", "claude");

    expect(result).toBeNull();
    expect(spawned).toBe(false);
    vi.doUnmock("../shared/installed-harnesses.js");
  });
});
