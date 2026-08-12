/**
 * docs/257 req 8 — the install-level "can actually run something" signal.
 *
 * Two things are under test, and the second is the one that decays:
 *
 *  1. `computeCanRunTurns` / `buildAgentListPayload` answer correctly.
 *  2. **Every** producer of the `agent_list` SSE carries the field. That is a
 *     source-level assertion rather than a behavioural one on purpose: a
 *     behavioural table over today's ten sites cannot notice an eleventh, and an
 *     eleventh that hand-rolls `{ agents }` is not a missing field on the client
 *     — it is a stale *truthy* one. Sign out of the last provider through a site
 *     that forgot, and the composer stays enabled over an install that can no
 *     longer run anything.
 */

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
    // The pre-docs/252 shape of the thing req 8 is really about: storing a
    // credential has not finished anything if nothing can run on it.
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
    // The state a fresh install is in: agents are registered and installed,
    // nothing is connected. The composer must be able to tell these apart.
    const payload = buildAgentListPayload(registry([
      { id: "claude", installed: true, hasRunnableModels: false },
    ]), undefined, undefined);
    expect(payload.canRunTurns).toBe(false);
    expect(payload.agents).toHaveLength(1);
  });
});

// ---- Every `agent_list` producer carries the field ----

const ORCHESTRATOR_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Every non-test `.ts` under `src/server/orchestrator`, recursively. */
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

/** Strip `//` and block comments so prose mentioning the event is not a producer. */
function stripComments(source: string): string {
  // Blanked rather than deleted, so offsets — and therefore the reported line
  // numbers — still match the original file.
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

interface Producer {
  /** `relative/path.ts:LINE`, so a failure names the site. */
  where: string;
  /** The payload expression as written, e.g. `buildAgentListPayload(registry, store)`. */
  payload: string;
  usesBuilder: boolean;
  /**
   * docs/257 phase 2 — the builder's second argument is the credential store,
   * and the compiler only forces *an* argument. A producer that passes
   * `undefined` compiles and emits a payload with no
   * `harnessOnboardingCompletedAt`, which is the same stale-value failure one
   * step removed: absent means "no news" to the client, so the onboarding panel
   * would linger over an install that just became runnable.
   */
  carriesStore: boolean;
  /**
   * docs/261 phase 3 (req 8) — the builder's third argument is the provider
   * account manager, and the same "the compiler only forces *an* argument"
   * hole applies. It is guarded separately because its failure is worse than
   * an absent field: without it the reviewer resolution cannot see an
   * account-delivered route, so every subscription-served reviewer is reported
   * **unavailable** — a confident wrong answer, pushed to every open tab, on
   * exactly the install where it is least true.
   */
  carriesAccountManager: boolean;
}

/**
 * Find every `agent_list` producer in one file's text.
 *
 * Matched over comment-stripped whole-file text rather than line by line, so a
 * producer whose arguments wrap across lines is still found. Exposed as a pure
 * function of source text so the scanner itself can be tested — a guard nobody
 * has checked is a guard that certifies whatever it happens to accept.
 */
function agentListProducersIn(rawSource: string, label: string): Producer[] {
  const source = stripComments(rawSource);
  const found: Producer[] = [];
  const patterns = [
    // sseBroadcast("agent_list", <payload>)
    /sseBroadcast\(\s*"agent_list"\s*,\s*([^;\n]*)/g,
    // client.write(`event: agent_list\ndata: ${JSON.stringify(<payload>)}`)
    /event:\s*agent_list[\s\S]{0,200}?JSON\.stringify\(([^;\n]*)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split("\n").length;
      const payload = match[1]!.trim();
      // A payload passed as a bare local — both provider-wide sign-outs do
      // this, because they also return `payload.agents` in the HTTP response.
      // Resolve it to its assignment rather than accepting a builder call that
      // merely happens to sit nearby, which a hand-rolled payload could.
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

/** Every site in the orchestrator that writes an `agent_list` SSE event. */
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
    // docs/261 phase 3 — compiles only in a two-argument world, but the shape a
    // careless edit reverts to. Caught here rather than left to the compiler,
    // for the same reason the store is: a site can also pass a literal
    // `undefined` and still compile.
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
    // The fixture is source *text*, so its interpolation is spelled with an
    // escape — written literally, `${` would interpolate in THIS file instead of
    // landing in the fixture.
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
    // docs/257 phase 2. The compiler forces a second argument; it does not stop
    // a site passing `undefined` and dropping `harnessOnboardingCompletedAt`.
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
    // docs/261 phase 3 (req 8). This payload carries the reviewer resolution,
    // which is what makes an open Reviewer tab follow a credential change. Drop
    // the manager and the resolver cannot see an account-delivered route, so a
    // subscription-only install is told both its reviewers are unavailable —
    // and it is told so by the very broadcast that fires when a subscription is
    // connected.
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
    // Not a magic number: the design's first draft listed seven of these and
    // missed the two provider-wide sign-outs (where the LAST credential goes)
    // and the reconnect snapshot. The eleventh is the broadcast this feature
    // ADDED to `POST /api/agents/:id/env`, which returned a fresh agent list to
    // the posting tab and announced it to nobody. Pinning the count makes a new
    // producer show up in review as a failing test that prints every site,
    // rather than as a silently stale composer months later.
    //
    // A total rather than a per-file or per-line census: moving a compliant
    // producer must not fail a test that is not about it. Only appearing and
    // disappearing producers move this number.
    //
    // Eleven became ten with docs/252 req 21: `POST
    // /api/provider-accounts/:provider/:id/primary` was deleted along with the
    // *Make primary* button, so its broadcast went too. Reordering — the verb
    // that survived — has a producer of its own and is unaffected. This is the
    // disappearing half of what the count is for.
    const producers = agentListProducers();
    expect(
      producers.length,
      producers.map((p) => `${p.where} — ${p.payload}`).join("\n"),
    ).toBe(10);
  });
});
