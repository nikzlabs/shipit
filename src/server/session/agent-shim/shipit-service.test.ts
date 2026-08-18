/**
 * Unit tests for `shipit service` (docs/238) — Compose service control.
 *
 * The shim talks to the worker over HTTP; the fake `call` here records the
 * transport's `timeoutMs` argument too, because the "unbounded transport for
 * start/restart" choice is the thing that makes an agent-initiated start of a
 * heavy service work at all (undici's non-disableable 300s headers timeout would
 * otherwise abort a cold image pull). A test that ignored that argument would
 * pass while the real bug came back.
 */

import { describe, it, expect } from "vitest";
import { runShim, type ShimIO } from "./shipit.js";

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body: unknown;
  timeoutMs?: number;
}

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeRunner() {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  const calls: RecordedCall[] = [];

  const io: ShimIO = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    exit: (code) => {
      exitCode = code;
      throw new Error("__shim_exit__");
    },
  };

  async function run(
    argv: string[],
    responses: Record<string, MockResponse> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; calls: RecordedCall[] }> {
    stdout = "";
    stderr = "";
    exitCode = null;
    calls.length = 0;

    const fakeCall = async (
      method: "GET" | "POST" | "PATCH",
      path: string,
      body: unknown,
      _env: unknown,
      timeoutMs?: number,
    ) => {
      calls.push({ method, path, body, timeoutMs });
      const key = `${method} ${path.split("?")[0]}`;
      return responses[key] ?? { status: 200, body: {} };
    };

    try {
      await runShim(argv, io, {}, fakeCall as never);
    } catch (err) {
      if (err instanceof Error && err.message !== "__shim_exit__") throw err;
    }
    return { stdout, stderr, exitCode, calls: [...calls] };
  }

  return { run };
}

const LIST_RESPONSE: MockResponse = {
  status: 200,
  body: {
    services: [
      { name: "web", status: "running", port: 5173, preview: "auto", url: "http://172.20.0.3:5173/" },
      { name: "db", status: "stopped", port: 5432, preview: "manual" },
    ],
  },
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("shipit service list", () => {
  it("renders a table with status, preview mode, port and agent-reachable url", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "list"], { "GET /services/list": LIST_RESPONSE });

    expect(res.exitCode).toBe(0);
    expect(res.calls[0]).toMatchObject({ method: "GET", path: "/services/list" });
    expect(res.stdout).toContain("NAME");
    expect(res.stdout).toContain("web");
    expect(res.stdout).toContain("running");
    expect(res.stdout).toContain("http://172.20.0.3:5173/");
    expect(res.stdout).toContain("db");
    expect(res.stdout).toContain("manual");
  });

  it("surfaces a per-service error rather than dropping it", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "list"], {
      "GET /services/list": {
        status: 200,
        body: { services: [{ name: "web", status: "error", preview: "auto", error: "exit 127" }] },
      },
    });
    expect(res.stdout).toContain("web: exit 127");
  });

  it("emits JSON with --json", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "list", "--json"], { "GET /services/list": LIST_RESPONSE });
    const parsed = JSON.parse(res.stdout) as { services: { name: string }[] };
    expect(parsed.services.map((s) => s.name)).toEqual(["web", "db"]);
  });

  it("explains the empty case instead of printing a bare header", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "list"], {
      "GET /services/list": { status: 200, body: { services: [] } },
    });
    expect(res.stdout).toContain("No services defined");
    expect(res.stdout).toContain("docker-compose.yml");
  });

  /**
   * planning#382 — the surface a docs/262 operator actually reported.
   *
   * "No services defined. Add them to docker-compose.yml" is right for a
   * project with no stack and WRONG for one whose stack was declined: it sends
   * the agent to write a file that already exists rather than to the line it
   * has to change. docs/263's `user:` rule declines a stock compose file, so
   * this was the first answer a normal project got.
   */
  describe("a compose file ShipIt declined", () => {
    const REFUSED = {
      status: 200,
      body: {
        services: [],
        failure: {
          kind: "refused",
          message: "Service `web`: contained services must declare a numeric, non-root `user:`.",
        },
      },
    };

    it("states the rule instead of claiming no services are defined", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list"], { "GET /services/list": REFUSED });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("refused");
      expect(res.stdout).toContain("numeric, non-root `user:`");
      // The wrong advice must be GONE, not merely accompanied by the right one.
      expect(res.stdout).not.toContain("No services defined");
    });

    it("does not offer a fix for a file it could not parse at all", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list"], {
        "GET /services/list": {
          status: 200,
          body: {
            services: [],
            failure: { kind: "malformed", message: "Compose file is not valid YAML: bad indent" },
          },
        },
      });
      expect(res.stdout).toContain("could not read");
      expect(res.stdout).toContain("not valid YAML");
      // `malformed` means ShipIt understood nothing, so there is no rule to
      // satisfy — telling the agent to "edit it to satisfy that rule" would be
      // an instruction it cannot follow.
      expect(res.stdout).not.toContain("satisfy that rule");
    });

    it("carries the reason on --json too", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list", "--json"], { "GET /services/list": REFUSED });
      const parsed = JSON.parse(res.stdout) as {
        services: unknown[];
        failure?: { kind: string; message: string };
      };
      expect(parsed.services).toEqual([]);
      expect(parsed.failure?.kind).toBe("refused");
      expect(parsed.failure?.message).toContain("user:");
    });

    it("keeps the table first when services exist alongside the failure", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list"], {
        "GET /services/list": {
          status: 200,
          body: {
            services: [{ name: "artk", status: "running", preview: "auto", port: 7000 }],
            failure: { kind: "refused", message: "Service `web`: `privileged: true` is not allowed." },
          },
        },
      });
      expect(res.stdout.indexOf("artk")).toBeLessThan(res.stdout.indexOf("refused"));
      expect(res.stdout).toContain("privileged");
    });
  });

  /**
   * nikzlabs/shipit#2429 — the list is where the reported diagnosis went wrong. The
   * service read `running`, every request failed on an unresolvable import, and
   * nothing here connected either to the rebase that rewrote the tree.
   */
  describe("dependencies that may not match the tree", () => {
    const GAP = {
      reason: "not-content-keyed",
      message:
        "`agent.install` was not re-run after a sync onto the latest base — installed " +
        "dependencies may not match this tree.",
    };

    it("says so beside a service that otherwise reads as healthy", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list"], {
        "GET /services/list": {
          status: 200,
          body: {
            services: [{ name: "dev", status: "running", preview: "auto", port: 5173 }],
            dependencies: GAP,
          },
        },
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("running");
      // The row and the note have to arrive together: the row is the reason the
      // agent stops looking, and the note is why it should not.
      expect(res.stdout).toContain("Dependencies:");
      expect(res.stdout).toContain("a sync onto the latest base");
    });

    it("carries the note on --json too", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list", "--json"], {
        "GET /services/list": { status: 200, body: { services: [], dependencies: GAP } },
      });
      const parsed = JSON.parse(res.stdout) as { dependencies?: { reason: string; message: string } };
      expect(parsed.dependencies?.reason).toBe("not-content-keyed");
      expect(parsed.dependencies?.message).toContain("not re-run");
    });

    it("survives an empty list, where the note is the only thing worth reading", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list"], {
        "GET /services/list": { status: 200, body: { services: [], dependencies: GAP } },
      });
      expect(res.stdout).toContain("No services defined");
      expect(res.stdout).toContain("Dependencies:");
    });

    it("is absent when there is nothing to report", async () => {
      const { run } = makeRunner();
      const res = await run(["service", "list"], {
        "GET /services/list": {
          status: 200,
          body: { services: [{ name: "dev", status: "running", preview: "auto" }] },
        },
      });
      expect(res.stdout).not.toContain("Dependencies:");
    });
  });

  it("points at compose.md when the project has no stack", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "list"], {
      "GET /services/list": { status: 500, body: { error: "No compose stack configured for this session" } },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("no docker-compose.yml");
  });
});

// ---------------------------------------------------------------------------
// start / restart
// ---------------------------------------------------------------------------

describe("shipit service start", () => {
  it("posts the service name and reports the polled status", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "db"], {
      "POST /services/start": {
        status: 200,
        body: { ok: true, name: "db", status: "running", port: 5432, url: "http://172.20.0.4:5432/" },
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.calls[0]).toMatchObject({ method: "POST", path: "/services/start", body: { name: "db" } });
    expect(res.stdout).toContain("db: running (started)");
    expect(res.stdout).toContain("http://172.20.0.4:5432/");
  });

  it("uses the UNBOUNDED transport so a cold image pull isn't aborted at 300s", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "db"], {
      "POST /services/start": { status: 200, body: { name: "db", status: "running" } },
    });
    // 0 = explicitly unbounded (Node http, not undici fetch). See shipit-service.ts.
    expect(res.calls[0].timeoutMs).toBe(0);
  });

  it("exits non-zero and points at logs when the service comes up in error", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "web"], {
      "POST /services/start": {
        status: 200,
        body: { ok: false, name: "web", status: "error", error: "exit 127" },
      },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("exit 127");
    expect(res.stderr).toContain("shipit service logs web");
  });

  it("reports an already-running service as a no-op", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "web"], {
      "POST /services/start": {
        status: 200,
        body: { name: "web", status: "running", alreadyRunning: true, url: "http://172.20.0.3:5173/" },
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("already running");
  });

  it("forwards --timeout as milliseconds", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "db", "--timeout", "90"], {
      "POST /services/start": { status: 200, body: { name: "db", status: "running" } },
    });
    expect(res.calls[0].body).toMatchObject({ name: "db", timeoutMs: 90_000 });
  });

  it("rejects a non-numeric --timeout", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "db", "--timeout", "soon"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--timeout");
  });

  it("requires a service name and names the discovery command", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("shipit service list");
  });

  it("points at list when the service name is unknown", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "start", "nope"], {
      "POST /services/start": { status: 500, body: { error: "Unknown service: nope" } },
    });
    expect(res.stderr).toContain("shipit service list");
  });

  it("restart uses the restart endpoint and the unbounded transport", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "restart", "web"], {
      "POST /services/restart": { status: 200, body: { name: "web", status: "running" } },
    });
    expect(res.calls[0]).toMatchObject({ method: "POST", path: "/services/restart" });
    expect(res.calls[0].timeoutMs).toBe(0);
    expect(res.stdout).toContain("restarted");
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("shipit service stop", () => {
  it("stops a service on the bounded transport", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "stop", "db"], {
      "POST /services/stop": { status: 200, body: { name: "db", status: "stopped" } },
    });
    expect(res.exitCode).toBe(0);
    expect(res.calls[0]).toMatchObject({ method: "POST", path: "/services/stop", body: { name: "db" } });
    // stop is quick; it must NOT opt into the unbounded transport.
    expect(res.calls[0].timeoutMs).toBeUndefined();
    expect(res.stdout).toContain("db: stopped");
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

describe("shipit service logs", () => {
  it("fetches logs and prints them verbatim", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "logs", "web"], {
      "GET /services/logs": { status: 200, body: { name: "web", logs: "line one\nline two" } },
    });
    expect(res.exitCode).toBe(0);
    expect(res.calls[0].path).toBe("/services/logs?name=web");
    expect(res.stdout).toContain("line one\nline two");
  });

  it("passes --lines through as a query param", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "logs", "web", "--lines", "50"], {
      "GET /services/logs": { status: 200, body: { logs: "x" } },
    });
    expect(res.calls[0].path).toBe("/services/logs?name=web&lines=50");
  });

  it("URL-encodes the service name", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "logs", "my svc"], {
      "GET /services/logs": { status: 200, body: { logs: "x" } },
    });
    expect(res.calls[0].path).toBe("/services/logs?name=my%20svc");
  });

  it("reports an empty log as an answer, not a blank line", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "logs", "db"], {
      "GET /services/logs": { status: 200, body: { name: "db", logs: "" } },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("(no logs for db)");
  });

  it("explains a 404 as a stale worker, not a bare 'Not Found'", async () => {
    // Fastify's no-such-route 404. An unknown *service* comes back as a 500
    // carrying `Unknown service: x`, so a 404 can only mean the worker in this
    // container predates the endpoint.
    const { run } = makeRunner();
    const res = await run(["service", "logs", "web"], {
      "GET /services/logs": { status: 404, body: { error: "Not Found", message: "Not Found" } },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("predates it");
    expect(res.stderr).toContain("/api/sessions/");
  });

  it("rejects a non-numeric --lines", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "logs", "web", "--lines", "many"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--lines");
  });
});

// ---------------------------------------------------------------------------
// Dispatch + allowlist
// ---------------------------------------------------------------------------

describe("shipit service dispatch", () => {
  it("accepts the `services` plural alias", async () => {
    const { run } = makeRunner();
    const res = await run(["services", "list"], { "GET /services/list": LIST_RESPONSE });
    expect(res.exitCode).toBe(0);
    expect(res.calls[0].path).toBe("/services/list");
  });

  it.each(["create", "delete", "build", "exec", "up", "down"])(
    "rejects `service %s` and points at docker-compose.yml",
    async (sub) => {
      const { run } = makeRunner();
      const res = await run(["service", sub, "db"]);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("docker-compose.yml");
      // No network call should have been attempted.
      expect(res.calls).toHaveLength(0);
    },
  );

  it("rejects an unknown subcommand", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "frobnicate"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("Unsupported shipit service subcommand");
  });

  it("rejects an unsupported flag", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "list", "--all"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--all");
  });

  it("prints help for `shipit service help`", async () => {
    const { run } = makeRunner();
    const res = await run(["service", "help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("shipit service start");
  });
});
