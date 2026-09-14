import { describe, it, expect } from "vitest";
import { runShim, type ShimIO } from "./shipit.js";

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
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

    const fakeCall = async (method: "GET" | "POST" | "PATCH", path: string) => {
      calls.push({ method, path });
      return responses[`${method} ${path.split("?")[0]}`] ?? { status: 200, body: {} };
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

const LIST: MockResponse = {
  status: 200,
  body: {
    tabs: ["advanced", "network", "voice"],
    settings: [
      {
        key: "advanced.enableSubAgents",
        label: "Allow spawning another agent for a sub-task",
        summary: "Lets the agent spawn another agent for a one-shot sub-task.",
        tab: "advanced",
        scope: "global",
        value: true,
        display: "true",
        readable: true,
        propose: { allowed: true },
        effect: { state: "live" },
        notes: [],
      },
      {
        key: "network.egressContained",
        label: "Contain outbound network access",
        summary: "Default-deny egress with an allowlist.",
        tab: "network",
        scope: "global",
        value: true,
        display: "true",
        readable: true,
        propose: { allowed: true },
        effect: {
          state: "restart-dependent",
          detail: "This session's container started open and stays that way until it is restarted.",
        },
        notes: [],
      },
      {
        key: "voice.speed",
        label: "Playback speed",
        summary: "How fast a voice note plays back.",
        tab: "voice",
        scope: "browser",
        value: null,
        display: "unknown",
        readable: false,
        unreadableReason: "browser_local",
        propose: { allowed: false, refusal: "browser_local", explanation: "This value is set in the user's browser." },
        effect: { state: "uncertain" },
        notes: ["Set in the browser; ShipIt's server does not hold this value."],
      },
    ],
  },
};

describe("shipit settings list", () => {
  it("groups by tab and shows each key with its value", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "list"], { "GET /agent-ops/settings/list": LIST });

    expect(res.exitCode).toBe(0);
    expect(res.calls[0]).toMatchObject({ method: "GET", path: "/agent-ops/settings/list" });
    expect(res.stdout).toContain("advanced:");
    expect(res.stdout).toContain("advanced.enableSubAgents = true");
    expect(res.stdout).toContain("Allow spawning another agent for a sub-task —");
  });

  it("marks a value that is saved but not in effect, with the reason", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "list"], { "GET /agent-ops/settings/list": LIST });

    expect(res.stdout).toContain("[restart-dependent — This session's container started open");
    // A live value carries no marker, so the exception is what stands out.
    expect(res.stdout).not.toContain("[live");
  });

  it("names a setting the server cannot read rather than dropping it", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "list"], { "GET /agent-ops/settings/list": LIST });

    expect(res.stdout).toContain("voice.speed = unreadable (browser_local)");
    // The reason is on the value line; an effect marker would repeat it.
    expect(res.stdout).not.toContain("[uncertain");
  });

  it("passes --tab through to the relay", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "list", "--tab", "network"], {
      "GET /agent-ops/settings/list": LIST,
    });

    expect(res.calls[0].path).toBe("/agent-ops/settings/list?tab=network");
  });

  it("prints the server's JSON unchanged under --json", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "list", "--json"], { "GET /agent-ops/settings/list": LIST });

    expect(JSON.parse(res.stdout)).toEqual(LIST.body);
  });

  it("fails with the server's message when the read fails", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "list"], {
      "GET /agent-ops/settings/list": { status: 404, body: { error: "Session not found" } },
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Session not found");
  });
});

describe("shipit settings get", () => {
  const DETAIL: MockResponse = {
    status: 200,
    body: {
      key: "advanced.releaseChannel",
      label: "Release channel",
      summary: "Which ShipIt releases this install follows.",
      description: "Which ShipIt releases this install follows.",
      tab: "advanced",
      scope: "global",
      value: "stable",
      display: "stable",
      readable: true,
      valueType: "enum",
      shape: { options: [{ value: "stable", label: "Stable" }, { value: "edge", label: "Edge" }] },
      propose: { allowed: true },
      effect: { state: "live" },
      notes: [],
    },
  };

  it("asks for the named key and renders the description and the accepted values", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "get", "advanced.releaseChannel"], {
      "GET /agent-ops/settings/get": DETAIL,
    });

    expect(res.exitCode).toBe(0);
    expect(res.calls[0].path).toBe("/agent-ops/settings/get?key=advanced.releaseChannel");
    expect(res.stdout).toContain("advanced.releaseChannel — Release channel");
    expect(res.stdout).toContain("Value: stable");
    expect(res.stdout).toContain("In effect: yes");
    expect(res.stdout).toContain("Accepts:");
    expect(res.stdout).toContain("edge");
  });

  it("says a setting cannot be changed on the agent's behalf, and why", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "get", "voice.webhook"], {
      "GET /agent-ops/settings/get": {
        status: 200,
        body: {
          ...DETAIL.body,
          key: "voice.webhook",
          value: { configured: true },
          display: "configured",
          propose: {
            allowed: false,
            refusal: "secret",
            explanation: "The user enters it in Settings.",
          },
        },
      },
    });

    expect(res.stdout).toContain("Cannot be changed on your behalf (secret).");
    expect(res.stdout).toContain("The user enters it in Settings.");
  });

  it("says a per-item setting is per-item, and what names one instance", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "get", "roles[].model"], {
      "GET /agent-ops/settings/get": {
        status: 200,
        body: {
          ...DETAIL.body,
          key: "roles[].model",
          address: { kind: "item", noun: "a role name" },
          items: [],
        },
      },
    });

    expect(res.stdout).toContain("Exists once per item, addressed by a role name.");
  });

  it("prints no effect line for a value it could not read", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "get", "roles[].model"], {
      "GET /agent-ops/settings/get": {
        status: 200,
        body: {
          ...DETAIL.body,
          key: "roles[].model",
          readable: false,
          unreadableReason: "read_failed",
          effect: { state: "uncertain" },
          notes: ["ShipIt could not read this setting's stored value."],
        },
      },
    });

    // The value line already said so; an effect line would say it twice.
    expect(res.stdout).toContain("Value: unreadable (read_failed)");
    expect(res.stdout).not.toContain("In effect");
  });

  it("does not read `uncertain` as `not in effect`", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "get", "network.egressContained"], {
      "GET /agent-ops/settings/get": {
        status: 200,
        body: {
          ...DETAIL.body,
          key: "network.egressContained",
          effect: { state: "uncertain", detail: "the container was rediscovered" },
        },
      },
    });

    expect(res.stdout).toContain("UNCONFIRMED");
    expect(res.stdout).not.toContain("In effect: NO");
  });

  it("requires a key", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "get"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("name the setting to read");
    expect(res.calls).toHaveLength(0);
  });
});

describe("shipit settings write verbs", () => {
  it("refuses `settings set` and says what to do instead", async () => {
    const { run } = makeRunner();
    const res = await run(["settings", "set", "advanced.autoFixCi=true"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("a ShipIt setting is the user's to change");
    expect(res.calls).toHaveLength(0);
  });
});
