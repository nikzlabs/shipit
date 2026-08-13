import { describe, it, expect } from "vitest";
import { buildComposeAttachReplay, type ComposeReplaySource } from "./compose-attach-replay.js";
import type { ManagedService } from "./service-manager.js";
import type { SecretsStatusInternalSnapshot } from "./service-secrets-resolver.js";

const emptySnapshot: SecretsStatusInternalSnapshot = {
  declared: [],
  missingByService: {},
  missingRequired: [],
  agentNames: [],
  plugins: [],
  agentValues: {},
};

function makeSource(overrides: {
  startError?: string;
  services?: ManagedService[];
  /** Providing this implies a sync has run; omit it for a not-yet-synced manager. */
  secrets?: Partial<SecretsStatusInternalSnapshot>;
  secretsSynced?: boolean;
} = {}): ComposeReplaySource {
  return {
    startError: overrides.startError,
    getServices: () => overrides.services ?? [],
    getSecretsSnapshot: () => ({ ...emptySnapshot, ...overrides.secrets }),
    secretsSynced: overrides.secretsSynced ?? overrides.secrets !== undefined,
  } as ComposeReplaySource;
}

describe("buildComposeAttachReplay", () => {
  it("replays declared secrets so a late viewer doesn't see them as custom", () => {
    const msgs = buildComposeAttachReplay(
      makeSource({
        secrets: {
          declared: [{ name: "STRIPE_KEY", required: true, services: ["api"] }],
          missingByService: { api: ["STRIPE_KEY"] },
          missingRequired: ["STRIPE_KEY"],
        },
      }),
      "s1",
    );

    const secrets = msgs.find((m) => m.type === "secrets_status");
    expect(secrets).toEqual({
      type: "secrets_status",
      sessionId: "s1",
      declared: [{ name: "STRIPE_KEY", required: true, services: ["api"] }],
      missingByService: { api: ["STRIPE_KEY"] },
      missingRequired: ["STRIPE_KEY"],
      plugins: [],
    });
  });

  // The manager's snapshot is the INTERNAL variant — it carries resolved secret
  // values for the agent-container push. The wire message must not.
  it("never puts resolved secret values on the wire", () => {
    const msgs = buildComposeAttachReplay(
      makeSource({
        secrets: {
          declared: [{ name: "DATABASE_URL", agent: true, services: ["db"] }],
          agentNames: ["DATABASE_URL"],
          agentValues: { DATABASE_URL: "postgres://user:hunter2@db/app" },
        },
      }),
      "s1",
    );

    expect(JSON.stringify(msgs)).not.toContain("hunter2");
    const secrets = msgs.find((m) => m.type === "secrets_status");
    expect(secrets).not.toHaveProperty("agentValues");
    expect(secrets).not.toHaveProperty("agentNames");
  });

  it("replays a secrets snapshot that is missing-required only (nothing declared yet)", () => {
    const msgs = buildComposeAttachReplay(
      makeSource({ secrets: { missingRequired: ["API_KEY"] } }),
      "s1",
    );
    expect(msgs.map((m) => m.type)).toEqual(["secrets_status"]);
  });

  // The client restores its own per-session snapshot on a switch, so an empty
  // replay is not neutral. Once a sync has run, an empty declared list is a
  // real answer — the compose file dropped its `x-shipit-secrets` — and the
  // client must be told so it clears the stale declared rows.
  it("replays an empty declared list once a sync has run", () => {
    const msgs = buildComposeAttachReplay(makeSource({ secrets: {} }), "s1");
    expect(msgs).toEqual([
      {
        type: "secrets_status",
        sessionId: "s1",
        declared: [],
        missingByService: {},
        missingRequired: [],
        plugins: [],
      },
    ]);
  });

  it("sends nothing when the manager has no state to replay", () => {
    expect(buildComposeAttachReplay(makeSource(), "s1")).toEqual([]);
  });

  // `setServices` clears `composeError` on the client, so a `service_list` sent
  // after the error would swallow the banner — the exact case a reconcile
  // failure on an already-running stack produces.
  it("orders compose_error after service_list so it isn't swallowed", () => {
    const msgs = buildComposeAttachReplay(
      makeSource({
        startError: "compose up failed",
        services: [
          { name: "web", status: "running", port: 3000, preview: "auto" } as ManagedService,
        ],
        secrets: { declared: [{ name: "STRIPE_KEY", services: ["web"] }] },
      }),
      "s1",
    );
    expect(msgs.map((m) => m.type)).toEqual([
      "service_list",
      "compose_error",
      "secrets_status",
    ]);
  });

  it("omits the service list when no services are known yet", () => {
    const msgs = buildComposeAttachReplay(
      makeSource({ secrets: { declared: [{ name: "K", services: ["web"] }] } }),
      "s1",
    );
    expect(msgs.map((m) => m.type)).toEqual(["secrets_status"]);
  });
});
