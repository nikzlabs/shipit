import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSessionName } from "./session-namer.js";
import type { UtilityModelConfig } from "./credential-store.js";

const ORIGINAL_FETCH = globalThis.fetch;

describe("generateSessionName", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  describe("anthropic provider", () => {
    it("returns parsed slug and title from API response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"slug": "add-login", "title": "Add Login Page"}' }],
          }),
          { status: 200 },
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const config: UtilityModelConfig = {
        provider: "anthropic",
        apiKey: "sk-ant-test",
        model: "claude-haiku-4-5",
      };
      const result = await generateSessionName("Add a login page", config);

      expect(result).toEqual({ slug: "add-login", title: "Add Login Page" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("returns null when apiKey is missing (no network call)", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await generateSessionName("hello", {
        provider: "anthropic",
        model: "claude-haiku-4-5",
      });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns null on HTTP error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("rate limited", { status: 429 }),
      ) as unknown as typeof fetch;

      const result = await generateSessionName("hello", {
        provider: "anthropic",
        apiKey: "sk-ant-test",
        model: "claude-haiku-4-5",
      });
      expect(result).toBeNull();
    });
  });

  describe("openai-compatible provider", () => {
    it("falls back from max_completion_tokens to max_tokens when 400'd", async () => {
      let calls = 0;
      const bodies: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
        calls++;
        bodies.push(init.body as string);
        if (calls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }),
              { status: 400 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"slug": "x", "title": "X"}' } }],
            }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch;

      const result = await generateSessionName("anything", {
        provider: "openai-compatible",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
      });

      expect(result).toEqual({ slug: "x", title: "X" });
      expect(calls).toBe(2);
      expect(bodies[0]).toContain("max_completion_tokens");
      expect(bodies[1]).toContain('"max_tokens"');
    });
  });

  describe("claude-cli provider", () => {
    // The CLI path uses execFile, so we mock node:child_process.
    // These tests run only when node_modules has been resolved correctly;
    // we use vi.mock with a dynamic factory to intercept the import.

    beforeEach(() => {
      vi.resetModules();
    });

    it("invokes the local claude CLI and parses the output", async () => {
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
            // emulate async completion
            setImmediate(() => {
              cb(null, '{"slug": "from-cli", "title": "From CLI"}\n', "");
            });
            return { on: () => {}, stdin: { end: () => {} } } as unknown;
          },
        };
      });

      const mod = await import("./session-namer.js");
      const result = await mod.generateSessionName("hello", {
        provider: "claude-cli",
        model: "haiku",
      });
      expect(result).toEqual({ slug: "from-cli", title: "From CLI" });
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
      const result = await mod.generateSessionName("hello", {
        provider: "claude-cli",
        model: "haiku",
      });
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
      const result = await mod.generateSessionName("hello", {
        provider: "claude-cli",
        model: "haiku",
      });
      expect(result).toBeNull();
    });
  });

  describe("output parsing", () => {
    it("trims slug to lowercase alphanumerics + hyphens, max 40 chars", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"slug": "Add Login!!! With Special@Chars-And-A-Very-Long-Name-That-Exceeds-Forty-Characters", "title": "Login"}' }],
          }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch;

      const result = await generateSessionName("x", {
        provider: "anthropic",
        apiKey: "sk-ant-test",
        model: "claude-haiku-4-5",
      });
      expect(result?.slug.length).toBeLessThanOrEqual(40);
      expect(result?.slug).toMatch(/^[a-z0-9-]+$/);
    });
  });
});
