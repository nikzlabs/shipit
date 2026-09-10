import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCanRunTurns, buildAgentListPayload } from "./settings.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";

function registry(
  agents: { id: string; installed: boolean; hasRunnableModels: boolean }[],
): AgentRegistry {
  return {
    list: () =>
      agents.map((a) => ({
        id: a.id,
        name: a.id,
        installed: a.installed,
        hasRunnableModels: a.hasRunnableModels,
        capabilities: {
          models: ["sonnet"],
          supportsReview: true,
          supportsSteering: true,
          supportsCompaction: true,
          supportedPermissionModes: ["auto"],
          skillInvocationPrefix: "/",
        },
      })),
  } as unknown as AgentRegistry;
}

describe("computeCanRunTurns (docs/257 req 8)", () => {
  it("is false when no agent has a credential", () => {
    expect(computeCanRunTurns(registry([
      { id: "claude", installed: true, hasRunnableModels: false },
      { id: "codex", installed: true, hasRunnableModels: false },
    ]))).toBe(false);
  });

  it("is true once one installed agent has a credential", () => {
    expect(computeCanRunTurns(registry([
      { id: "claude", installed: true, hasRunnableModels: true },
      { id: "codex", installed: true, hasRunnableModels: false },
    ]))).toBe(true);
  });

  it("is false for a credential no installed harness can use", () => {
    expect(computeCanRunTurns(registry([
      { id: "codex", installed: false, hasRunnableModels: true },
    ]))).toBe(false);
  });

  it("is false on an install with no registered agents at all", () => {
    expect(computeCanRunTurns(registry([]))).toBe(false);
  });
});

describe("buildAgentListPayload", () => {
  it("carries the agent list and the runnable signal together", () => {
    const payload = buildAgentListPayload(registry([
      { id: "claude", installed: true, hasRunnableModels: true },
    ]), undefined, undefined);
    expect(payload.canRunTurns).toBe(true);
    expect(payload.agents).toEqual([
      expect.objectContaining({ id: "claude", installed: true, hasRunnableModels: true }),
    ]);
  });

  it("reports not-runnable alongside a non-empty agent list", () => {
    const payload = buildAgentListPayload(registry([
      { id: "claude", installed: true, hasRunnableModels: false },
    ]), undefined, undefined);
    expect(payload.canRunTurns).toBe(false);
    expect(payload.agents).toHaveLength(1);
  });
});

const ORCHESTRATOR_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "integration_tests") continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  // Preserve offsets for reported line numbers.
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

interface Producer {
  where: string;
  payload: string;
  usesBuilder: boolean;
  carriesStore: boolean;
  carriesAccountManager: boolean;
}

function agentListProducersIn(rawSource: string, label: string): Producer[] {
  const source = stripComments(rawSource);
  const found: Producer[] = [];
  const patterns = [
    /sseBroadcast\(\s*"agent_list"\s*,\s*([^;\n]*)/g,
    /event:\s*agent_list[\s\S]{0,200}?JSON\.stringify\(([^;\n]*)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split("\n").length;
      const payload = match[1]!.trim();
      // Resolve a local payload's assignment, not an unrelated nearby builder call.
      const local = /^([A-Za-z_$][\w$]*)\s*\)/.exec(payload)?.[1];
      const assigned = local
        ? new RegExp(`\\b(?:const|let|var)\\s+${local}\\s*=\\s*([^;\\n]*)`).exec(source)?.[1] ?? ""
        : "";
      const call = payload.includes("buildAgentListPayload(") ? payload : assigned;
      found.push({
        where: `${label}:${line}`,
        payload,
        usesBuilder: call.includes("buildAgentListPayload("),
        carriesStore: /buildAgentListPayload\([^)]*\bcredentialStore\b/.test(call),
        carriesAccountManager: /buildAgentListPayload\([^)]*\bproviderAccountManager\b/.test(call),
      });
    }
  }
  return found;
}

function agentListProducers(): Producer[] {
  return sourceFiles(ORCHESTRATOR_DIR)
    .flatMap((file) =>
      agentListProducersIn(
        fs.readFileSync(file, "utf8"),
        path.relative(ORCHESTRATOR_DIR, file),
      ),
    )
    .sort((a, b) => a.where.localeCompare(b.where));
}

describe("the producer scanner itself", () => {
  const scan = (src: string) => agentListProducersIn(src, "fixture");

  it("accepts a compliant broadcast", () => {
    const found = scan(
      `sseBroadcast("agent_list", buildAgentListPayload(reg, credentialStore, providerAccountManager));`,
    );
    expect(found).toEqual([
      expect.objectContaining({ usesBuilder: true, carriesStore: true, carriesAccountManager: true }),
    ]);
  });

  it("accepts a payload assigned to a local first", () => {
    const found = scan([
      `const payload = buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager);`,
      `deps.sseBroadcast("agent_list", payload);`,
    ].join("\n"));
    expect(found).toEqual([
      expect.objectContaining({ usesBuilder: true, carriesStore: true, carriesAccountManager: true }),
    ]);
  });

  it("rejects a builder call that hard-codes `undefined` for the store", () => {
    const found = scan(`sseBroadcast("agent_list", buildAgentListPayload(reg, undefined));`);
    expect(found).toEqual([expect.objectContaining({ usesBuilder: true, carriesStore: false })]);
  });

  it("rejects a builder call that omits the provider account manager", () => {
    const found = scan(`sseBroadcast("agent_list", buildAgentListPayload(reg, credentialStore));`);
    expect(found).toEqual([
      expect.objectContaining({ usesBuilder: true, carriesStore: true, carriesAccountManager: false }),
    ]);
  });

  it("rejects a hand-rolled payload, even next to an unrelated builder call", () => {
    const found = scan([
      `const other = buildAgentListPayload(reg);`,
      `sseBroadcast("agent_list", { agents: listAgents(reg) });`,
    ].join("\n"));
    expect(found).toEqual([expect.objectContaining({ usesBuilder: false })]);
  });

  it("finds a producer whose arguments wrap across lines", () => {
    const found = scan([`sseBroadcast(`, `  "agent_list",`, `  { agents },`, `);`].join("\n"));
    expect(found).toEqual([expect.objectContaining({ usesBuilder: false })]);
  });

  it("finds the SSE snapshot form", () => {
    const found = scan(
      `client.write(\`event: agent_list\\ndata: \${JSON.stringify({ agents })}\`);`,
    );
    expect(found).toEqual([expect.objectContaining({ usesBuilder: false })]);
  });

  it("ignores prose in comments", () => {
    const found = scan([
      `// sseBroadcast("agent_list", { agents }) is how this used to work`,
      `/* event: agent_list is documented here */`,
    ].join("\n"));
    expect(found).toEqual([]);
  });
});

describe("agent_list producers all carry canRunTurns", () => {
  it("routes every producer through buildAgentListPayload", () => {
    const offenders = agentListProducers()
      .filter((p) => !p.usesBuilder)
      .map((p) => `${p.where} — ${p.payload}`);
    expect(
      offenders,
      "each of these emits `agent_list` without buildAgentListPayload(), so the "
        + "payload has no canRunTurns and a client can be left with a stale truthy one",
    ).toEqual([]);
  });

  it("hands every producer the credential store, not `undefined`", () => {
    const offenders = agentListProducers()
      .filter((p) => !p.carriesStore)
      .map((p) => `${p.where} — ${p.payload}`);
    expect(
      offenders,
      "each of these builds the payload without a credential store, so it carries "
        + "no harnessOnboardingCompletedAt and the onboarding panel lingers over an "
        + "install that just became runnable",
    ).toEqual([]);
  });

  it("hands every producer the provider account manager, not `undefined`", () => {
    const offenders = agentListProducers()
      .filter((p) => !p.carriesAccountManager)
      .map((p) => `${p.where} — ${p.payload}`);
    expect(
      offenders,
      "each of these builds the payload without a provider account manager, so its "
        + "reviewer resolution cannot see account-delivered routes and reports a "
        + "subscription-served reviewer as unavailable",
    ).toEqual([]);
  });

  it("finds every producer docs/257 enumerated", () => {
    // Count changes require review; moving a producer must not fail this guard.
    const producers = agentListProducers();
    expect(
      producers.length,
      producers.map((p) => `${p.where} — ${p.payload}`).join("\n"),
    ).toBe(11);
  });
});
