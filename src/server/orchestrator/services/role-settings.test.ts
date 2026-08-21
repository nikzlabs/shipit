import { describe, it, expect } from "vitest";
import type { AgentRole, CredentialRoute } from "../../shared/types.js";
import type { RolePinnedParams } from "../../shared/types/agent-types.js";
import { applyRoleWrites, parseRoleWrite, planRoleWrites } from "./role-settings.js";
import { ServiceError } from "./types.js";

/**
 * docs/264 phase 2 (reqs 5, 6, 8, 9, 17, 18) — role CRUD through the settings
 * mutation surface.
 *
 * **Driven against the real catalogue**, like `roles.test.ts`: what these
 * assertions say about which harness can carry which model, and which levels
 * each declares, are statements about ShipIt's own catalogue, and a fabricated
 * one would let them pass while disagreeing with what actually runs.
 *
 * The dual-harness pair is real and is the fixture: `deepseek-v4-flash` is
 * carried by both `claude` and `codex` (`services.ts` declares all three styles
 * on it), and their level sets differ — `max` is Claude Code's and not Codex's.
 * That pair is what makes the harness a *choice* a role has to express (req 6)
 * rather than something derivable from the model.
 */

const EMPTY_ENV: NodeJS.ProcessEnv = {};

function route(serviceId: string, billingMode: "sub" | "key"): CredentialRoute {
  return {
    serviceId,
    billingMode,
    id: `${serviceId}-${billingMode}`,
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
  };
}

const DEEPSEEK_KEY = route("deepseek", "key");

/**
 * A store that answers the two verbs the write path uses, recording what was
 * written in order — the order is the assertion for a rename, which must write
 * the new name before deleting the old one.
 */
function storeWith(roles: AgentRole[] = [], routes: CredentialRoute[] = [DEEPSEEK_KEY]) {
  const byName = new Map(roles.map((role) => [role.name, role]));
  const writes: { name: string; role: AgentRole | null }[] = [];
  const store = {
    getRole: (name: string) => byName.get(name),
    setRole: (name: string, role: AgentRole | null) => {
      writes.push({ name, role });
      if (role === null) byName.delete(name);
      else byName.set(name, role);
    },
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) => (routes.some((r) => r.id === id) ? "sk-test" : undefined),
    getSelectionMode: () => "strict" as const,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
    getRoles: () => [...byName.values()],
    getReviewerPin: () => undefined,
  };
  return { store, writes, byName };
}

function depsFor(store: ReturnType<typeof storeWith>["store"]) {
  return { credentialStore: store, env: EMPTY_ENV, isInstalled: () => true };
}

const REVIEWER: AgentRole = { name: "reviewer", params: { kind: "auto" } };

/** A tuple the catalogue really accepts: DeepSeek's flash model under Claude Code. */
const PINNED = {
  kind: "pinned",
  harnessId: "claude",
  serviceId: "deepseek",
  billingMode: "key",
  modelId: "deepseek-v4-flash",
  reasoningEffort: "high",
} satisfies RolePinnedParams;

function write(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { params: PINNED, ...over };
}

function apply(roles: unknown, seed: AgentRole[] = [REVIEWER]) {
  const fixture = storeWith(seed);
  applyRoleWrites(roles, fixture.store, depsFor(fixture.store));
  return fixture;
}

function refusal(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error("expected a ServiceError");
}

// ---- Create, edit, delete (reqs 5, 17) --------------------------------------

describe("applyRoleWrites — one editor, one write (req 17)", () => {
  it("creates a role with its name, description, standing instructions and params at once", () => {
    const { byName } = apply({
      "deep-dive": write({ description: "The thorough one", prompt: "Read requirements.md first" }),
    });
    expect(byName.get("deep-dive")).toEqual({
      name: "deep-dive",
      description: "The thorough one",
      prompt: "Read requirements.md first",
      params: PINNED,
    });
  });

  it("edits an existing role in place when previousName matches the key", () => {
    const existing: AgentRole = { name: "deep-dive", description: "old", params: PINNED };
    const { byName, writes } = apply(
      { "deep-dive": write({ previousName: "deep-dive", description: "new" }) },
      [REVIEWER, existing],
    );
    expect(byName.get("deep-dive")?.description).toBe("new");
    // One write, and no delete: an in-place edit is not a rename.
    expect(writes).toHaveLength(1);
  });

  it("clears an optional field when the editor sends it empty (reqs 8, 9)", () => {
    const existing: AgentRole = {
      name: "deep-dive",
      description: "old",
      prompt: "old brief",
      params: PINNED,
    };
    const { byName } = apply(
      { "deep-dive": write({ previousName: "deep-dive", description: "", prompt: "   " }) },
      [REVIEWER, existing],
    );
    expect(byName.get("deep-dive")).toEqual({ name: "deep-dive", params: PINNED });
  });

  it("deletes with null", () => {
    const { byName } = apply({ "deep-dive": null }, [
      REVIEWER,
      { name: "deep-dive", params: PINNED },
    ]);
    expect(byName.has("deep-dive")).toBe(false);
  });
});

// ---- Rename (req 18) --------------------------------------------------------

describe("applyRoleWrites — a rename is a write plus a delete", () => {
  it("writes the new name BEFORE deleting the old one", () => {
    const { writes, byName } = apply(
      { "deeper-dive": write({ previousName: "deep-dive" }) },
      [REVIEWER, { name: "deep-dive", params: PINNED }],
    );
    expect(writes.map((w) => [w.name, w.role === null ? "delete" : "write"])).toEqual([
      ["deeper-dive", "write"],
      ["deep-dive", "delete"],
    ]);
    expect(byName.has("deep-dive")).toBe(false);
    expect(byName.get("deeper-dive")?.name).toBe("deeper-dive");
  });

  it("refuses a rename onto a name that already exists (req 18's only rule)", () => {
    const err = refusal(() =>
      apply({ taken: write({ previousName: "deep-dive" }) }, [
        REVIEWER,
        { name: "deep-dive", params: PINNED },
        { name: "taken", params: PINNED },
      ]),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("already exists");
  });

  it("refuses a create whose name is taken, rather than overwriting it", () => {
    const fixture = storeWith([REVIEWER, { name: "deep-dive", description: "mine", params: PINNED }]);
    const err = refusal(() =>
      applyRoleWrites({ "deep-dive": write() }, fixture.store, depsFor(fixture.store)),
    );
    expect(err.message).toContain("already exists");
    expect(fixture.byName.get("deep-dive")?.description).toBe("mine");
  });

  it("refuses an edit whose previousName no longer exists", () => {
    const err = refusal(() => apply({ gone: write({ previousName: "gone" }) }));
    expect(err.message).toContain("No role named");
  });

  it("accepts any name the user types — spaces, case and punctuation all (req 18)", () => {
    const { byName } = apply({ "  Deep Dive (v2)!  ": write() });
    // Stored EXACTLY as typed: nothing is normalized, so a name with spaces
    // round it stays a distinct name rather than colliding with the trimmed one.
    expect([...byName.keys()]).toContain("  Deep Dive (v2)!  ");
  });

  it("refuses a blank name", () => {
    expect(refusal(() => apply({ "   ": write() })).message).toContain("blank");
  });
});

// ---- The reviewer (req 2) ---------------------------------------------------

describe("applyRoleWrites — the reviewer is present, editable, and neither renamed nor deleted", () => {
  it("refuses to delete it", () => {
    const err = refusal(() => apply({ reviewer: null }));
    expect(err.message).toContain("cannot be deleted");
  });

  it("refuses to rename it", () => {
    const err = refusal(() => apply({ "my reviewer": write({ previousName: "reviewer" }) }));
    expect(err.message).toContain("cannot be renamed");
  });

  it("refuses to pin its params", () => {
    const err = refusal(() =>
      apply({ reviewer: write({ previousName: "reviewer" }) }),
    );
    expect(err.message).toContain("cannot be pinned");
  });

  it("edits its description and standing instructions", () => {
    const { byName } = apply({
      reviewer: {
        previousName: "reviewer",
        description: "Second opinion",
        prompt: "Review only; do not edit",
        params: { kind: "auto" },
      },
    });
    expect(byName.get("reviewer")).toEqual({
      name: "reviewer",
      description: "Second opinion",
      prompt: "Review only; do not edit",
      params: { kind: "auto" },
    });
  });

  it("refuses another role taking the reserved name", () => {
    const err = refusal(() => apply({ reviewer: write() }));
    expect(err.message).toContain("reserved");
  });

  it("refuses automatic params on any other name", () => {
    const err = refusal(() => apply({ "deep-dive": { params: { kind: "auto" } } }));
    expect(err.message).toContain("automatic params");
  });
});

// ---- The harness-explicit validator does the params (reqs 6, 7) -------------

describe("applyRoleWrites — params are refused at SAVE, naming the parameter (req 6)", () => {
  it("refuses a level the named harness does not declare, for a model both harnesses carry", () => {
    // `max` is Claude Code's level and not Codex's, and `deepseek-v4-flash` runs
    // on both — so this is refusable only because the role NAMES its harness.
    const err = refusal(() =>
      apply({ "deep-dive": write({ params: { ...PINNED, harnessId: "codex", reasoningEffort: "max" } }) }),
    );
    expect(err.message).toContain("max");
  });

  it("accepts that same tuple when the role names Claude Code", () => {
    const { byName } = apply({
      "deep-dive": write({ params: { ...PINNED, reasoningEffort: "max" } }),
    });
    expect(byName.get("deep-dive")?.params).toMatchObject({ reasoningEffort: "max" });
  });

  it("accepts an OMITTED level — Default is a level a role may name (req 1)", () => {
    const { reasoningEffort: _dropped, ...atDefault } = PINNED;
    const { byName } = apply({ "deep-dive": write({ params: atDefault }) });
    const params = byName.get("deep-dive")?.params;
    expect(params).toMatchObject({ harnessId: "claude", modelId: "deepseek-v4-flash" });
    // Stored as the ABSENCE of the key, so a round-trip through the credential
    // store's JSON cannot turn Default into a level.
    expect(params && "reasoningEffort" in params).toBe(false);
  });

  it("refuses a BLANK level — a client that meant Default and encoded it wrong", () => {
    // `""` is not Default, and accepting it would store a level no harness
    // declares. The message names the parameter and how to say Default.
    const err = refusal(() =>
      apply({ "deep-dive": write({ params: { ...PINNED, reasoningEffort: "" } }) }),
    );
    expect(err.message).toContain("reasoningEffort");
  });

  it("accepts the OTHER harness for the same model — the dual-harness choice a role can express", () => {
    const { byName } = apply({
      "deep-dive": write({ params: { ...PINNED, harnessId: "codex", reasoningEffort: "high" } }),
    });
    expect(byName.get("deep-dive")?.params).toMatchObject({ harnessId: "codex" });
  });

  it("refuses a harness that cannot speak to the model at all", () => {
    const err = refusal(() =>
      apply({
        "deep-dive": write({
          params: {
            ...PINNED,
            harnessId: "codex",
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-opus-5",
            reasoningEffort: "high",
          },
        }),
      }),
    );
    expect(err.message).toMatch(/cannot speak|no credential/i);
  });

  it("refuses a model no service offers", () => {
    const err = refusal(() =>
      apply({ "deep-dive": write({ params: { ...PINNED, modelId: "no-such-model" } }) }),
    );
    expect(err.message).toContain("no-such-model");
  });
});

/**
 * **A save checks compatibility, never live availability** — `plan.md`'s rule and
 * phase 1's own checklist bullet, which the write path did not obey.
 *
 * A missing credential is the *service's* state: `resolveRoleView` reports it as
 * `disconnected` and says the remedy is to reconnect the service and leave the
 * role alone. Validating it at save contradicted that where it mattered most —
 * the whole role is revalidated on every write (one editor, one write, req 17),
 * so a disconnected role could not be edited AT ALL. Changing only its
 * description was rejected for a credential the edit did not touch and could not
 * restore. Every catalogue check still refuses, which is what req 6 asks for.
 */
describe("applyRoleWrites — a disconnected role is still editable (req 5)", () => {
  /** The role's service has no credential here: the disconnected state exactly. */
  const NO_ROUTES: CredentialRoute[] = [];

  function applyWithoutCredentials(roles: unknown, seed: AgentRole[] = [REVIEWER]) {
    const fixture = storeWith(seed, NO_ROUTES);
    applyRoleWrites(roles, fixture.store, depsFor(fixture.store));
    return fixture;
  }

  it("saves a description-only edit to a role whose credential is gone", () => {
    const existing: AgentRole = { name: "deep-dive", description: "old", params: PINNED };
    const { byName } = applyWithoutCredentials(
      { "deep-dive": write({ previousName: "deep-dive", description: "new" }) },
      [REVIEWER, existing],
    );
    expect(byName.get("deep-dive")).toEqual({
      name: "deep-dive",
      description: "new",
      params: PINNED,
    });
  });

  it("creates a role for a service this install has not connected yet", () => {
    // Nothing about the tuple is wrong, and the list will say `disconnected`
    // with "reconnect the service" as the remedy — which is a better answer than
    // refusing the role and leaving the user nothing to reconnect it FOR.
    const { byName } = applyWithoutCredentials({ "deep-dive": write() });
    expect(byName.get("deep-dive")?.params).toEqual(PINNED);
  });

  it("still refuses a tuple fault on the same uncredentialed install", () => {
    // The save did not stop checking — it stopped checking the one fact that
    // changes without anyone editing a role.
    const err = refusal(() =>
      applyWithoutCredentials({
        "deep-dive": write({ params: { ...PINNED, harnessId: "codex", reasoningEffort: "max" } }),
      }),
    );
    expect(err.message).toContain("max");
  });
});

// ---- Nothing is written until everything validates ---------------------------

describe("planRoleWrites — every entry validated before any is written", () => {
  it("persists nothing when a later entry in the batch is invalid", () => {
    const fixture = storeWith([REVIEWER]);
    refusal(() =>
      applyRoleWrites(
        {
          good: write(),
          bad: write({ params: { ...PINNED, reasoningEffort: "not-a-level" } }),
        },
        fixture.store,
        depsFor(fixture.store),
      ),
    );
    expect(fixture.writes).toEqual([]);
    expect(fixture.byName.has("good")).toBe(false);
  });

  it("refuses an entry whose sibling already took the name it renames away from", () => {
    // Rename a → b while also creating a. The create is checked against the
    // store as it stands BEFORE the batch, where "a" still exists, so it is
    // refused rather than racing the rename's delete.
    const fixture = storeWith([REVIEWER, { name: "a", params: PINNED }]);
    const err = refusal(() =>
      applyRoleWrites(
        { b: write({ previousName: "a" }), a: write() },
        fixture.store,
        depsFor(fixture.store),
      ),
    );
    expect(err.message).toContain("already exists");
    expect(fixture.writes).toEqual([]);
  });

  it("rejects a container that is not an object", () => {
    const fixture = storeWith([REVIEWER]);
    const err = refusal(() => applyRoleWrites([], fixture.store, depsFor(fixture.store)));
    expect(err.message).toContain("keyed by role name");
  });

  it("returns a plan without writing anything", () => {
    const fixture = storeWith([REVIEWER]);
    const plans = planRoleWrites({ "deep-dive": write() }, fixture.store, depsFor(fixture.store));
    expect(plans).toHaveLength(1);
    expect(fixture.writes).toEqual([]);
  });
});

// ---- Shape errors name the field --------------------------------------------

describe("parseRoleWrite", () => {
  it("null is a delete", () => {
    expect(parseRoleWrite(null, "x")).toBeNull();
  });

  it("names the field on a malformed entry", () => {
    expect(refusal(() => parseRoleWrite("nope", "x")).message).toContain("role object or null");
    expect(refusal(() => parseRoleWrite({}, "x")).message).toContain("params is required");
    expect(
      refusal(() => parseRoleWrite({ params: { kind: "pinned" } }, "x")).message,
    ).toContain("harnessId is required");
    expect(
      refusal(() => parseRoleWrite({ params: PINNED, description: 3 }, "x")).message,
    ).toContain("description must be a string");
  });

  it("requires the harness — a role without one is not a role (req 6)", () => {
    const withoutHarness = { ...PINNED } as Record<string, unknown>;
    delete withoutHarness.harnessId;
    expect(
      refusal(() => parseRoleWrite({ params: withoutHarness }, "x")).message,
    ).toContain("harnessId");
  });
});
