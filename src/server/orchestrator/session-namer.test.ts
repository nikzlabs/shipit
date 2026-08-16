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
          // docs/252 phase 7 — the JSON envelope, so naming's telemetry can be
          // recorded rather than discarded (req 16).
          expect(args).toContain("json");
          setImmediate(() => {
            cb(null, '{"slug": "add-login", "title": "Add Login Page"}\n', "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("Add a login page", { harnessId: "claude" });
    expect(result.name).toEqual({ slug: "add-login", title: "Add Login Page" });
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
    await mod.generateSessionName("hi", {
      harnessId: "claude",
      credentialRoot: "/credentials/provider-accounts/claude/acct_work",
    });

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
    await mod.generateSessionName("hi", { harnessId: "claude" });

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
          // planning#341 — the JSONL stream, so a naming run's tokens can be
          // recorded rather than vanishing (req 16). Bare prose on stdout, as
          // mocked below, still names: the parser degrades to reading it as text.
          expect(args).toContain("--json");
          expect(args[args.length - 1]).toContain("Add a login page");
          setImmediate(() => {
            cb(null, '{"slug": "add-login", "title": "Add Login Page"}\n', "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("Add a login page", { harnessId: "codex" });
    expect(result.name).toEqual({ slug: "add-login", title: "Add Login Page" });
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
    const result = await mod.generateSessionName("hello", { harnessId: "claude" });
    expect(result.name).toBeNull();
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
    const result = await mod.generateSessionName("hello", { harnessId: "claude" });
    expect(result.name).toBeNull();
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
    const result = await mod.generateSessionName("x", { harnessId: "claude" });
    expect(result.name?.slug.length).toBeLessThanOrEqual(40);
    expect(result.name?.slug).toMatch(/^[a-z0-9-]+$/);
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
    await mod.generateSessionName("hi", {
      harnessId: "codex",
      credentialRoot: "/credentials/provider-accounts/codex/acct_work",
    });

    expect(order).toEqual([
      "gate:/credentials/provider-accounts/codex/acct_work/.codex",
      "spawn:codex",
    ]);
    vi.doUnmock("./agents/codex/home-init.js");
  });

  // planning#390 — the gate follows the home the spawn actually uses, so an
  // UNSCOPED run (a redirected service, which resolves no account root) is
  // covered too. It used to be skipped entirely on the premise that only an
  // account route can put two processes in one root; once the Codex adapter
  // stopped inheriting an ambient HOME, an unscoped turn spawns against this
  // very root and the two race it cold.
  it("initializes the process-global Codex root when naming resolves no account", async () => {
    const savedHome = process.env.HOME;
    process.env.HOME = "/workspace/.inner-shipit/agent-home";
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
    await mod.generateSessionName("hi", { harnessId: "codex" });

    expect(order).toEqual([
      "gate:/workspace/.inner-shipit/agent-home/.codex",
      "spawn:codex",
    ]);
    vi.doUnmock("./agents/codex/home-init.js");
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = savedHome;
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
    await mod.generateSessionName("hi", {
      harnessId: "claude",
      credentialRoot: "/credentials/provider-accounts/claude/acct_work",
    });

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
    const result = await mod.generateSessionName("x", { harnessId: "claude" });
    expect(result.name?.title.length).toBeLessThanOrEqual(60);
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
    const result = await mod.generateSessionName("hi", { harnessId: "claude" });

    expect(result.name).toBeNull();
    expect(spawned).toBe(false);
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  // docs/252 phase 7 (req 9) — naming runs on the model chosen for non-turn
  // work, pointed at that model's service. The shaping goes through the SAME
  // `applyServiceRouting` a turn's spawn uses: a second implementation is how a
  // naming run ends up authenticating differently from the turn it names.
  it("shapes the Claude spawn at the selected service and forwards the model", async () => {
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        seenArgs = args;
        seenEnv = opts.env ?? {};
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", {
      harnessId: "claude",
      model: "deepseek-v4-flash",
      serviceRouting: {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        style: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        credentialSourceEnv: "DEEPSEEK_API_KEY",
        credentialTarget: { kind: "env", name: "ANTHROPIC_API_KEY" },
      },
      credentialSecret: "sk-deepseek",
    });

    expect(seenArgs).toContain("--model");
    expect(seenArgs).toContain("deepseek-v4-flash");
    expect(seenEnv.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(seenEnv.ANTHROPIC_API_KEY).toBe("sk-deepseek");
  });

  // The orchestrator's own ambient credentials must not leak into a redirected
  // naming run — the same clear-then-set rule the turn path applies.
  it("refuses to name when the selected service has no credential to deliver", async () => {
    let spawned = false;
    vi.doMock("node:child_process", () => ({
      execFile: () => {
        spawned = true;
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("hi", {
      harnessId: "claude",
      serviceRouting: {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        style: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        credentialSourceEnv: "DEEPSEEK_API_KEY",
        credentialTarget: { kind: "env", name: "ANTHROPIC_API_KEY" },
      },
    });

    expect(spawned).toBe(false);
    expect(result.name).toBeNull();
    expect(result.failure).toContain("DeepSeek");
  });

  // req 16 — naming can be pointed at a metered service, so what it spent has
  // to be reportable. `--output-format json` is what makes that possible.
  it("carries the JSON envelope's telemetry back to the caller", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => cb(null, JSON.stringify({
          result: '{"slug": "s", "title": "T"}',
          total_cost_usd: 0.004,
          duration_ms: 2100,
          usage: {
            input_tokens: 900,
            output_tokens: 40,
            cache_read_input_tokens: 12,
            cache_creation_input_tokens: 3,
          },
        }), ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("hi", { harnessId: "claude" });

    expect(result.name).toEqual({ slug: "s", title: "T" });
    expect(result.usage).toEqual({
      durationMs: 2100,
      costUsd: 0.004,
      inputTokens: 900,
      outputTokens: 40,
      cacheReadTokens: 12,
      cacheCreateTokens: 3,
    });
  });

  // Guarded by construction: an envelope the parser does not recognize degrades
  // to reading stdout as text, which is exactly the pre-phase-7 behaviour.
  it("still names when the CLI returns bare text instead of the JSON envelope", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => cb(null, '{"slug": "bare", "title": "Bare"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("hi", { harnessId: "claude" });

    expect(result.name).toEqual({ slug: "bare", title: "Bare" });
  });

  // planning#341 — the gap this closes. `codex exec` printed prose and nothing
  // else, so a naming run on a metered service spent money and wrote no usage
  // row. The JSONL's `turn.completed` carries the figures; the shapes below are
  // verbatim from codex-cli 0.146.0 driving a local Responses recorder.
  describe("codex exec --json telemetry", () => {
    const mockCodex = (stdout: string): void => {
      vi.doMock("node:child_process", () => ({
        execFile: (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          setImmediate(() => cb(null, stdout, ""));
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      }));
    };

    it("parses the agent message and the turn's usage from the JSONL stream", async () => {
      mockCodex([
        '{"type":"thread.started","thread_id":"019fe844"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message",'
        + '"text":"{\\"slug\\": \\"add-login\\", \\"title\\": \\"Add Login Page\\"}"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,'
        + '"cache_write_input_tokens":5,"output_tokens":42,"reasoning_output_tokens":7}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("Add a login page", { harnessId: "codex" });

      expect(result.name).toEqual({ slug: "add-login", title: "Add Login Page" });
      // `input_tokens` is the TOTAL and both cache figures are details of it,
      // so ordinary input is 1000 - 800 - 5. `costFromRates` charges each class
      // a replacement rate, and Codex reports no dollar figure that would mask
      // a double count.
      expect(result.usage).toEqual({
        durationMs: expect.any(Number),
        inputTokens: 195,
        outputTokens: 42,
        cacheReadTokens: 800,
        cacheCreateTokens: 5,
      });
      // Codex reports no dollar figure. Absent, not zero — a $0 here would be
      // priced as free instead of priced from the catalogue's rates.
      expect(result.usage?.costUsd).toBeUndefined();
    });

    it("still reports the usage when the title does not parse", async () => {
      // The tokens were consumed either way, which is exactly why
      // `graduate-session` records usage outside the `name === null` branch.
      mockCodex([
        '{"type":"item.completed","item":{"type":"agent_message","text":"Sorry, I cannot."}}',
        '{"type":"turn.completed","usage":{"input_tokens":300,"output_tokens":9}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toBeNull();
      expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 9 });
    });

    it("treats an error item as the failure detail only when no message arrived", async () => {
      mockCodex([
        '{"type":"item.completed","item":{"type":"error","message":"stream disconnected"}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toBeNull();
      expect(result.failure).toBe("stream disconnected");
      expect(result.usage?.inputTokens).toBeUndefined();
      expect(result.usage?.costUsd).toBeUndefined();
    });

    it("names normally when a non-fatal error item precedes a completed turn", async () => {
      // Observed on the real CLI: an unknown model id emits an `error` item
      // ("Model metadata … not found") and the turn then completes normally.
      mockCodex([
        '{"type":"item.completed","item":{"type":"error","message":"Model metadata not found."}}',
        '{"type":"item.completed","item":{"type":"agent_message",'
        + '"text":"{\\"slug\\": \\"ok\\", \\"title\\": \\"Ok\\"}"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toEqual({ slug: "ok", title: "Ok" });
      expect(result.failure).toBeUndefined();
    });

    // Cross-backend review found this one: `usage: {}` is truthy, so a naive
    // guard turned it into `{input: 0, output: 0}` — defined zeros, which
    // `recordNonTurnUsage` reads as telemetry and prices to $0 through the
    // rates. That is the exact "this was free" assertion the issue forbids.
    it("treats a present-but-empty usage block as no telemetry, not as free", async () => {
      mockCodex([
        '{"type":"item.completed","item":{"type":"agent_message",'
        + '"text":"{\\"slug\\": \\"s\\", \\"title\\": \\"T\\"}"}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toEqual({ slug: "s", title: "T" });
      expect(result.usage?.inputTokens).toBeUndefined();
      expect(result.usage?.outputTokens).toBeUndefined();
    });

    // Also review's: the fallback must not be conditioned on the stream being
    // unrecognizable end to end. A mixed stream, or a future CLI that renames
    // the agent-message event, would otherwise lose naming outright — and the
    // flag exists for telemetry, which must never cost naming its title.
    it("falls back to raw stdout when the stream carries no agent message", async () => {
      mockCodex([
        '{"type":"thread.started","thread_id":"x"}',
        '{"slug": "mixed", "title": "Mixed"}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toEqual({ slug: "mixed", title: "Mixed" });
      // The telemetry still lands — the fallback is about the text, not the row.
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    });

    it("reports no tokens and no cost when the stream carries no usage at all", async () => {
      // The distinction the whole issue turns on: no telemetry is not free.
      // What survives is the wall clock, which `recordNonTurnUsage` reads as
      // nothing to record rather than as a $0 run.
      mockCodex('{"type":"item.completed","item":{"type":"agent_message",'
        + '"text":"{\\"slug\\": \\"s\\", \\"title\\": \\"T\\"}"}}');

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toEqual({ slug: "s", title: "T" });
      expect(result.usage?.inputTokens).toBeUndefined();
      expect(result.usage?.outputTokens).toBeUndefined();
      expect(result.usage?.costUsd).toBeUndefined();
    });
  });

  // docs/150 / docs/252 — a run scoped to a provider-account root must not
  // inherit the orchestrator's own environment credentials: both CLIs prefer
  // the variable over the login on disk, so the dogfood host (which has one
  // configured) would bill metered API usage while this run is attributed to
  // the selected subscription. Found by cross-backend review.
  it("drops the orchestrator's ambient credentials for an account-scoped run", async () => {
    let seenEnv: Record<string, string> = {};
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        seenEnv = opts.env ?? {};
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ambient");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok-ambient");

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", {
      harnessId: "claude",
      credentialRoot: "/credentials/provider-accounts/claude/acct_work",
    });

    expect(seenEnv.HOME).toBe("/credentials/provider-accounts/claude/acct_work");
    expect(seenEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seenEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    vi.unstubAllEnvs();
  });

  // The other half of that rule: a reserved env/API-key route resolves no
  // account root and its variables ARE its auth, so they must survive.
  it("keeps the environment credential when no account root applies", async () => {
    let seenEnv: Record<string, string> = {};
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        seenEnv = opts.env ?? {};
        setImmediate(() => cb(null, '{"slug": "s", "title": "T"}\n', ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ambient");

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", { harnessId: "claude" });

    expect(seenEnv.ANTHROPIC_API_KEY).toBe("sk-ambient");
    vi.unstubAllEnvs();
  });
});
