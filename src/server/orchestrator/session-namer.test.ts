import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("generateSessionName", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
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
          setImmediate(() => {
            cb(null, '{"slug": "add-login", "title": "Add Login Page"}\n', "");
          });
          return { on: () => {}, stdin: { end: () => {} } } as unknown;
        },
      };
    });

    const mod = await import("./session-namer.js");
    const result = await mod.generateSessionName("Add a login page");
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
    const result = await mod.generateSessionName("hello");
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
    const result = await mod.generateSessionName("hello");
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
    const result = await mod.generateSessionName("x");
    expect(result?.slug.length).toBeLessThanOrEqual(40);
    expect(result?.slug).toMatch(/^[a-z0-9-]+$/);
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
    const result = await mod.generateSessionName("x");
    expect(result?.title.length).toBeLessThanOrEqual(60);
  });
});
