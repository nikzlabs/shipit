import { describe, it, expect, vi } from "vitest";
import {
  runGitCredential,
  parseCredentialInput,
  type CredIO,
} from "./git-credential.js";

/** Build a capturing IO stub with a canned stdin payload. */
function makeIO(stdin: string): { io: CredIO; out: string[]; err: string[]; code: () => number | null } {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const io: CredIO = {
    readStdin: () => Promise.resolve(stdin),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    exit: (c) => {
      exitCode = c;
    },
  };
  return { io, out, err, code: () => exitCode };
}

describe("parseCredentialInput", () => {
  it("parses key=value lines and stops at the blank terminator", () => {
    const attrs = parseCredentialInput("protocol=https\nhost=github.com\n\npath=ignored\n");
    expect(attrs).toEqual({ protocol: "https", host: "github.com" });
  });

  it("tolerates CRLF line endings", () => {
    const attrs = parseCredentialInput("protocol=https\r\nhost=github.com\r\n\r\n");
    expect(attrs.host).toBe("github.com");
  });
});

describe("runGitCredential: get", () => {
  it("brokers to the worker and prints username/password for github.com", async () => {
    const { io, out, code } = makeIO("protocol=https\nhost=github.com\n\n");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ username: "x-access-token", password: "ghp_brokered" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await runGitCredential(["get"], { io, env: { workerUrl: "http://127.0.0.1:9100" }, fetchImpl });

    expect(out.join("")).toBe("username=x-access-token\npassword=ghp_brokered\n");
    expect(code()).toBe(0);
    // The host was forwarded to the broker.
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://127.0.0.1:9100/agent-ops/git/credential");
    expect(JSON.parse(call[1].body)).toMatchObject({ host: "github.com", protocol: "https" });
  });

  it("prints nothing (exit 0) when the broker has no credential (404)", async () => {
    const { io, out, code } = makeIO("protocol=https\nhost=example.com\n\n");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "No credential available for host" }), { status: 404 }),
    ) as unknown as typeof fetch;

    await runGitCredential(["get"], { io, fetchImpl });

    expect(out.join("")).toBe("");
    expect(code()).toBe(0);
  });

  it("prints nothing (exit 0) when the worker is unreachable", async () => {
    const { io, out, code } = makeIO("protocol=https\nhost=github.com\n\n");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await runGitCredential(["get"], { io, fetchImpl });

    expect(out.join("")).toBe("");
    expect(code()).toBe(0);
  });

  it("prints nothing when the broker returns a malformed body", async () => {
    const { io, out, code } = makeIO("protocol=https\nhost=github.com\n\n");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    await runGitCredential(["get"], { io, fetchImpl });

    expect(out.join("")).toBe("");
    expect(code()).toBe(0);
  });
});

describe("runGitCredential: store/erase are no-ops", () => {
  it("store drains stdin and exits 0 without calling the broker", async () => {
    const { io, out, code } = makeIO("protocol=https\nhost=github.com\nusername=x\npassword=y\n\n");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await runGitCredential(["store"], { io, fetchImpl });

    expect(out.join("")).toBe("");
    expect(code()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("erase is a no-op", async () => {
    const { io, code } = makeIO("");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await runGitCredential(["erase"], { io, fetchImpl });
    expect(code()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
