import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleEditor } from "./RoleEditor.js";
import type { AgentOption } from "../../../agent-types.js";
import type { RoleView } from "../../../../server/shared/types/agent-types.js";

/**
 * docs/264 phase 2 (reqs 2, 6, 8, 9, 17) — the role editor itself.
 *
 * The bullet most likely to be built wrong is req 6's harness control, so it is
 * pinned against the real rows rather than convenient ones: **`deepseek-flash`
 * is carried by both installed harnesses** and `claude-opus-5` by one, which is
 * exactly what the shipped catalogue has (`deepseek-flash` declares all three
 * API styles, so both harnesses share it; no other row does). A read-only
 * harness field would leave the first
 * of those unable to say which harness it means. The catalogue itself is pinned
 * server-side, where its rules live — `services/role-settings.test.ts` and
 * `integration_tests/role-settings-api.test.ts` both drive the real one.
 *
 * The other case a picker-based editor gets wrong is a role whose stored model,
 * service or harness is gone: with no option to select, the shared pickers would
 * either drop the field or silently show the first available value, and the user
 * would then save a role they never chose.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-opus-5", "deepseek-flash"],
    eligibleModels: [
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        label: "Opus 5",
        canonicalModelKey: "claude-opus-5",
      },
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-flash",
        label: "V4.1 Flash",
        canonicalModelKey: "deepseek-v4.1-flash",
      },
    ],
    supportsReview: true,
    reasoning: {
      label: "Reasoning",
      options: [
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
    },
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-flash"],
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-flash",
        label: "V4.1 Flash",
        canonicalModelKey: "deepseek-v4.1-flash",
      },
    ],
    supportsReview: true,

    reasoning: {
      label: "Reasoning effort",
      options: [
        { value: "minimal", label: "Minimal" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
    },
  },
];

function roleOn(
  params: {
    harnessId: string;
    serviceId: string;
    billingMode: "sub" | "key";
    modelId: string;

    reasoningEffort?: string;
  },
  over: Partial<RoleView> = {},
): RoleView {
  return {
    name: "deep-dive",
    reserved: false,
    params: { kind: "pinned", ...params } as RoleView["params"],
    ...over,
  };
}

const DUAL_HARNESS = {
  harnessId: "claude",
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-flash",
  reasoningEffort: "max",
};

function open(role: RoleView | undefined) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <RoleEditor
      role={role}
      agentList={agents}
      busy={false}
      error={undefined}
      onCancel={onCancel}
      onSave={onSave}
    />,
  );
  return { onSave, onCancel };
}

function savedParams(onSave: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, write] = onSave.mock.calls[0] as [string, { params: Record<string, unknown> }];
  return write.params;
}

describe("RoleEditor — the harness is a real control where the model has a choice", () => {
  it("offers a picker for a model both harnesses carry", async () => {
    open(roleOn(DUAL_HARNESS));
    const trigger = screen.getByTestId("role-editor-harness-trigger");
    expect(trigger.textContent).toContain("Claude Code");
    await userEvent.click(trigger);
    expect(screen.getByTestId("role-editor-harness-option-claude")).toBeTruthy();
    expect(screen.getByTestId("role-editor-harness-option-codex")).toBeTruthy();
  });

  it("drops to Default when the new harness does not declare the level", async () => {
    const { onSave } = open(roleOn({
      ...DUAL_HARNESS,
      harnessId: "codex",
      reasoningEffort: "minimal",
    }));
    await userEvent.click(screen.getByTestId("role-editor-harness-trigger"));
    await userEvent.click(screen.getByTestId("role-editor-harness-option-claude"));
    await userEvent.click(screen.getByTestId("role-editor-save"));

    // `minimal` is Codex's level and not Claude Code's, so the draft cannot keep it

    const saved = savedParams(onSave);
    expect(saved).toMatchObject({ harnessId: "claude", modelId: "deepseek-flash" });
    expect(saved).not.toHaveProperty("reasoningEffort");
  });

  it("keeps a level the new harness DOES declare", async () => {
    const { onSave } = open(roleOn({ ...DUAL_HARNESS, reasoningEffort: "high" }));
    await userEvent.click(screen.getByTestId("role-editor-harness-trigger"));
    await userEvent.click(screen.getByTestId("role-editor-harness-option-codex"));
    await userEvent.click(screen.getByTestId("role-editor-save"));
    expect(savedParams(onSave)).toMatchObject({ harnessId: "codex", reasoningEffort: "high" });
  });

  it("is a readout, not a picker, where the model has exactly one valid harness", () => {
    open(
      roleOn({
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      }),
    );
    expect(screen.queryByTestId("role-editor-harness-trigger")).toBeNull();
    expect(screen.getByTestId("role-editor-harness-readout").textContent).toContain("Claude Code");
  });

  it("stays a PICKER when the stored harness is gone and one replacement is valid", async () => {

    const claudeOnly = [agents[0]];
    const onSave = vi.fn();
    render(
      <RoleEditor
        role={roleOn({ ...DUAL_HARNESS, harnessId: "codex" })}
        agentList={claudeOnly}
        busy={false}
        error={undefined}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    const trigger = screen.getByTestId("role-editor-harness-trigger");

    expect(trigger.textContent).toContain("codex");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("role-editor-harness-option-claude"));
    await userEvent.click(screen.getByTestId("role-editor-save"));
    expect(savedParams(onSave)).toMatchObject({ harnessId: "claude", reasoningEffort: "max" });
  });

  it("moves the harness onto the new model's own set when the model changes", async () => {
    const { onSave } = open(roleOn({ ...DUAL_HARNESS, harnessId: "codex", reasoningEffort: "high" }));
    // Switch to the service whose only model Codex cannot carry.
    await userEvent.click(screen.getByTestId("role-editor-service-trigger"));
    await userEvent.click(screen.getByTestId("role-editor-service-option-anthropic:sub"));
    await userEvent.click(screen.getByTestId("role-editor-save"));

    expect(savedParams(onSave)).toMatchObject({
      harnessId: "claude",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
    });
  });
});

describe("RoleEditor — a role whose tuple no longer resolves", () => {
  const gone = roleOn({
    harnessId: "codex",
    serviceId: "retired-service",
    billingMode: "key",
    modelId: "retired-model",
    reasoningEffort: "ultra",
  });

  it("opens on the raw stored values rather than the first available option", () => {
    open(gone);
    expect(screen.getByTestId("role-editor-service-trigger").textContent).toContain(
      "retired-service",
    );
    expect(screen.getByTestId("role-editor-model-trigger").textContent).toContain("retired-model");
    expect(screen.getByTestId("role-editor-harness-readout").textContent).toContain("codex");
    expect(screen.getByTestId("role-editor-reasoning-readout").textContent).toContain("ultra");
  });

  it("saves the stored tuple unchanged when nothing is touched — no silent rewrite", async () => {
    const { onSave } = open(gone);
    await userEvent.click(screen.getByTestId("role-editor-save"));
    expect(savedParams(onSave)).toEqual({
      kind: "pinned",
      harnessId: "codex",
      serviceId: "retired-service",
      billingMode: "key",
      modelId: "retired-model",
      reasoningEffort: "ultra",
    });
  });

  it("re-points it when the user picks a service that does exist", async () => {
    const { onSave } = open(gone);
    await userEvent.click(screen.getByTestId("role-editor-service-trigger"));
    await userEvent.click(screen.getByTestId("role-editor-service-option-deepseek:key"));
    await userEvent.click(screen.getByTestId("role-editor-save"));
    expect(savedParams(onSave)).toMatchObject({ serviceId: "deepseek", modelId: "deepseek-flash" });
  });
});

describe("RoleEditor — the whole role in one place", () => {
  it("carries previousName when editing, so a rename is not a create", async () => {
    const { onSave } = open(roleOn(DUAL_HARNESS));
    await userEvent.clear(screen.getByTestId("role-editor-name"));
    await userEvent.type(screen.getByTestId("role-editor-name"), "deeper dive");
    await userEvent.click(screen.getByTestId("role-editor-save"));
    const [name, write] = onSave.mock.calls[0] as [string, { previousName?: string }];
    expect(name).toBe("deeper dive");
    expect(write.previousName).toBe("deep-dive");
  });

  it("says the agent reads the description", () => {
    open(roleOn(DUAL_HARNESS));
    expect(screen.getByText(/agent reads it/i)).toBeTruthy();
  });

  it("cannot be saved with no name", async () => {
    const { onSave } = open(undefined);
    await userEvent.click(screen.getByTestId("role-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("proposes a complete tuple for a new role — a role is complete on its own (req 1)", async () => {
    const { onSave } = open(undefined);
    await userEvent.type(screen.getByTestId("role-editor-name"), "new one");
    await userEvent.click(screen.getByTestId("role-editor-save"));

    const saved = savedParams(onSave);
    expect(saved).toMatchObject({
      kind: "pinned",
      harnessId: "claude",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
    expect(saved).not.toHaveProperty("reasoningEffort");
  });

  it("offers Default alongside the harness's levels, as the composer does (req 1)", async () => {
    open(roleOn(DUAL_HARNESS));
    await userEvent.click(screen.getByTestId("role-editor-reasoning-trigger"));

    expect(screen.getByTestId("role-editor-reasoning-option-default")).toBeTruthy();
    expect(screen.getByTestId("role-editor-reasoning-option-max")).toBeTruthy();
  });

  it("saves a role at Default by omitting the level, not by sending a blank", async () => {
    const { onSave } = open(roleOn(DUAL_HARNESS));
    await userEvent.click(screen.getByTestId("role-editor-reasoning-trigger"));
    await userEvent.click(screen.getByTestId("role-editor-reasoning-option-default"));
    await userEvent.click(screen.getByTestId("role-editor-save"));

    // the server refuses it precisely so a client cannot mean Default that way.
    expect(savedParams(onSave)).not.toHaveProperty("reasoningEffort");
  });

  it("opens an existing role at Default showing Default, not a substituted level", async () => {
    const { reasoningEffort: _dropped, ...atDefault } = DUAL_HARNESS;
    open(roleOn(atDefault));
    expect(screen.getByTestId("role-editor-reasoning-trigger").textContent).toContain("Default");
  });

  it("edits the reviewer's metadata only — no name, no params (req 2)", async () => {
    const { onSave } = open({ name: "reviewer", params: { kind: "auto" }, reserved: true });
    expect(screen.queryByTestId("role-editor-name")).toBeNull();
    expect(screen.queryByTestId("role-editor-model-trigger")).toBeNull();
    expect(screen.getByTestId("role-editor-auto-note")).toBeTruthy();

    await userEvent.type(screen.getByTestId("role-editor-prompt"), "Review only; do not edit");
    await userEvent.click(screen.getByTestId("role-editor-save"));
    const [name, write] = onSave.mock.calls[0] as [
      string,
      { previousName?: string; prompt?: string; params: { kind: string } },
    ];
    expect(name).toBe("reviewer");
    expect(write.previousName).toBe("reviewer");
    expect(write.params.kind).toBe("auto");
    expect(write.prompt).toBe("Review only; do not edit");
  });

  it("shows the server's refusal beside the controls", () => {
    render(
      <RoleEditor
        role={roleOn(DUAL_HARNESS)}
        agentList={agents}
        busy={false}
        error='The role "deep-dive" cannot run: "minimal" is not a reasoning level Claude Code offers.'
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByTestId("role-editor-error").textContent).toContain("Claude Code offers");
  });

  it("says so when the install has nothing to run a role on", () => {
    render(
      <RoleEditor
        role={undefined}
        agentList={[]}
        busy={false}
        error={undefined}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByTestId("role-editor-no-models")).toBeTruthy();
  });
});
