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

  it("gives ChatGPT naming an access-only home instead of the canonical Codex home", async () => {
    const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "oc-naming-source-"));
    fs.mkdirSync(path.join(source, ".codex"));
    const access_token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "external-a" } })).toString("base64url")}.test`;
    fs.writeFileSync(path.join(source, ".codex/auth.json"), JSON.stringify({ tokens: { access_token, refresh_token: "source-refresh-only" } }));
    let home: string | undefined;
    vi.doMock("node:child_process", () => ({
      execFile: (_file: string, args: string[], opts: { env: Record<string, string> }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        home = opts.env.HOME;
        expect(home).not.toBe(source);
        expect(fs.existsSync(path.join(home, ".codex/auth.json"))).toBe(false);
        expect(fs.readFileSync(path.join(opts.env.XDG_DATA_HOME, "opencode/auth.json"), "utf8")).not.toContain("source-refresh-only");
        expect(args).toContain("openai/gpt-5.5");
        setImmediate(() => cb(null, JSON.stringify({ type: "text", part: { type: "text", text: '{"slug":"account-test","title":"Account Test"}' } }), ""));
        return { on: () => {}, stdin: { end: () => {} } };
      },
    }));
    try {
      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("test", { harnessId: "opencode", model: "gpt-5.5", credentialRoot: source, serviceRouting: { serviceId: "openai", serviceName: "OpenAI", billingMode: "sub", style: "openai-responses", baseUrl: "https://api.openai.com/v1", credentialTarget: { kind: "openai-chatgpt", accountId: "account-a" } } });
      expect(result.name).toEqual({ slug: "account-test", title: "Account Test" });
      expect(home && fs.existsSync(home)).toBe(false);
    } finally { fs.rmSync(source, { recursive: true, force: true }); }
  });

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

  it("gives OpenCode naming a scratch XDG data root and leaves the home untouched", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const savedHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "naming-home-"));
    process.env.HOME = home;

    let dataHome: string | undefined;
    let existedDuringSpawn = false;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        dataHome = opts.env?.XDG_DATA_HOME;
        existedDuringSpawn = !!dataHome && fs.existsSync(dataHome);
        setImmediate(() => cb(null, "", ""));
        return { on: () => {}, stdin: { end: () => {} } } as unknown;
      },
    }));

    const mod = await import("./session-namer.js");
    await mod.generateSessionName("hi", { harnessId: "opencode", model: "deepseek/x" });

    expect(dataHome).toBeTruthy();
    expect(existedDuringSpawn).toBe(true);
    expect(dataHome!.startsWith(home)).toBe(false);
    expect(fs.existsSync(path.join(home, ".local", "share", "opencode"))).toBe(false);
    expect(fs.existsSync(dataHome!)).toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = savedHome;
  });

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
      model: "deepseek-flash",
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
    expect(seenArgs).toContain("deepseek-flash");
    expect(seenEnv.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(seenEnv.ANTHROPIC_API_KEY).toBe("sk-deepseek");
  });

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

  // Fixtures follow codex-cli 0.146.0 output captured with a local Responses recorder.
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
      expect(result.usage).toEqual({
        durationMs: expect.any(Number),
        inputTokens: 195,
        outputTokens: 42,
        cacheReadTokens: 800,
        cacheCreateTokens: 5,
      });
      expect(result.usage?.costUsd).toBeUndefined();
    });

    it("still reports the usage when the title does not parse", async () => {
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

    it("falls back to raw stdout when the stream carries no agent message", async () => {
      mockCodex([
        '{"type":"thread.started","thread_id":"x"}',
        '{"slug": "mixed", "title": "Mixed"}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
      ].join("\n"));

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hi", { harnessId: "codex" });

      expect(result.name).toEqual({ slug: "mixed", title: "Mixed" });
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    });

    it("reports no tokens and no cost when the stream carries no usage at all", async () => {
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
