import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useRepoStore } from "../../../stores/repo-store.js";
import { useEgressStore } from "../../../stores/egress-store.js";
import { useScheduleStore } from "../../../stores/schedule-store.js";
import { reasoningOptionsFor } from "../../../../server/shared/catalogue/index.js";
import { saveModelId } from "../../../utils/local-storage.js";
import type { AgentOption } from "../../../agent-types.js";
import type { RoleView } from "../../../../server/shared/types/agent-types.js";
import type { ScheduleView, SessionStartParams } from "../../../../server/shared/types.js";

/**
 * docs/324-scheduled-sessions reqs 4, 5, 11 — the editor sets every session-start parameter.
 * `EDITS` is typed over `SessionStartParams`, so a parameter added to session start does not
 * compile here until the editor can set it.
 */

const REPO = "https://github.com/nikzlabs/shipit";

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-opus-5"],
    eligibleModels: [
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        label: "Opus 5",
        canonicalModelKey: "claude-opus-5",
      },
    ],
    supportsReview: true,
    supportedPermissionModes: ["auto", "plan", "guarded"],
    reasoning: { label: "Reasoning", options: reasoningOptionsFor("claude", undefined) },
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: [],
    eligibleModels: [],
    supportsReview: true,
  },
];

const AUDITOR: RoleView = {
  name: "auditor",
  reserved: false,
  params: { kind: "pinned", harnessId: "claude", serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" },
};

const LEVEL = reasoningOptionsFor("claude", undefined)[0]!.value;

function schedule(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "sched-1",
    name: "Security PR sweep",
    enabled: true,
    timing: { kind: "weekdays", hour: 9, minute: 0 },
    timeZone: "UTC",
    spec: { target: { kind: "repo", repoUrl: REPO }, params: {}, prompt: "Check the security PRs." },
    activeSince: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRuns: [],
    ...over,
  };
}

let saved: Record<string, unknown>[];

function stubServer() {
  saved = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/ssh-hosts") {
      return { ok: true, status: 200, json: async () => ({ hosts: [{ id: "host-1", label: "Prod", user: "deploy", address: "prod.example", port: 22 }] }) };
    }
    if (url === "/api/egress/settings") {
      return { ok: true, status: 200, json: async () => ({ globalEnabled: false, enforcementActive: true, enforcementStatus: "active" }) };
    }
    if (url === "/api/schedules/sched-1" && init?.method === "PUT") {
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      saved.push(body);
      return { ok: true, status: 200, json: async () => ({ schedule: { ...schedule(), ...body } }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: `unexpected ${url}` }) };
  }));
}

async function pick(trigger: string, option: string) {
  await userEvent.click(screen.getByTestId(trigger));
  await userEvent.click(await screen.findByTestId(option));
}

async function savedParams(): Promise<SessionStartParams> {
  await userEvent.click(screen.getByTestId("schedule-editor-save"));
  await waitFor(() => expect(saved).toHaveLength(1));
  return (saved[0]!.spec as { params: SessionStartParams }).params;
}

interface Edit<K extends keyof SessionStartParams> {
  edit: () => Promise<void>;
  value: SessionStartParams[K];
}

const pickModel = () => pick("schedule-editor-model-trigger", "schedule-editor-model-option-claude-opus-5");

const EDITS: { [K in keyof SessionStartParams]-?: Edit<K> } = {
  role: { edit: () => pick("role-selector-trigger", "role-option-auditor"), value: "auditor" },
  agent: { edit: () => pick("schedule-editor-harness-trigger", "schedule-editor-harness-option-codex"), value: "codex" },
  // One control sets the model, its service and its billing mode.
  model: { edit: pickModel, value: "claude-opus-5" },
  serviceId: { edit: pickModel, value: "anthropic" },
  billingMode: { edit: pickModel, value: "sub" },
  reasoning: {
    edit: async () => {
      await pickModel();
      await pick("schedule-editor-reasoning-trigger", `schedule-editor-reasoning-option-${LEVEL}`);
    },
    value: LEVEL,
  },
  permissionMode: { edit: () => pick("permission-mode-selector", "permission-mode-option-plan"), value: "plan" },
  networkMode: { edit: () => pick("permission-mode-selector", "network-mode-option-contained"), value: true },
  sshHosts: {
    edit: async () => { await userEvent.click(await screen.findByTestId("schedule-editor-ssh-host-host-1")); },
    value: ["host-1"],
  },
  armAutoMerge: { edit: () => userEvent.click(screen.getByTestId("schedule-editor-auto-merge")), value: true },
};

beforeEach(() => {
  vi.unstubAllGlobals();
  saveModelId(undefined);
  stubServer();
  useUiStore.setState({ agentList: agents, activeAgentId: "claude" });
  useSettingsStore.getState().setRoles([{ name: "reviewer", params: { kind: "auto" }, reserved: true }, AUDITOR]);
  useRepoStore.getState().setRepos([{ url: REPO, addedAt: "", lastUsedAt: "", status: "ready" }]);
  useEgressStore.setState({ globalLoaded: false });
  useScheduleStore.getState().reset();
});

describe("ScheduleEditor — every session-start parameter (reqs 4, 5, 11)", () => {
  for (const [key, { edit, value }] of Object.entries(EDITS) as [keyof SessionStartParams, Edit<keyof SessionStartParams>][]) {
    it(`sets ${key}`, async () => {
      render(<ScheduleEditor schedule={schedule()} onClose={vi.fn()} />);
      await edit();
      expect((await savedParams())[key]).toEqual(value);
    });
  }

  it("lets a role replace the harness, model and level, as in the composer", async () => {
    render(
      <ScheduleEditor
        schedule={schedule({
          spec: {
            target: { kind: "repo", repoUrl: REPO },
            params: { agent: "claude", model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub", reasoning: LEVEL },
            prompt: "p",
          },
        })}
        onClose={vi.fn()}
      />,
    );
    await pick("role-selector-trigger", "role-option-auditor");
    expect(screen.queryByTestId("schedule-editor-model-trigger")).toBeNull();
    expect(await savedParams()).toEqual({ role: "auditor" });
  });
});

describe("ScheduleEditor — editing one parameter", () => {
  it("keeps every other parameter as it was", async () => {
    const params: SessionStartParams = {
      agent: "claude",
      model: "claude-opus-5",
      serviceId: "anthropic",
      billingMode: "sub",
      reasoning: LEVEL,
      networkMode: false,
      sshHosts: ["host-1"],
      armAutoMerge: true,
    };
    render(<ScheduleEditor schedule={schedule({ spec: { target: { kind: "repo", repoUrl: REPO }, params, prompt: "p" } })} onClose={vi.fn()} />);
    await pick("permission-mode-selector", "permission-mode-option-plan");
    expect(await savedParams()).toEqual({ ...params, permissionMode: "plan" });
  });

  it("offers the permission modes a role's own model can take, not the composer's", async () => {
    saveModelId("claude-opus-5");
    useSettingsStore.getState().setRoles([{
      ...AUDITOR,
      resolved: {
        harnessId: "claude", harnessName: "Claude Code", serviceId: "anthropic", billingMode: "sub",
        serviceName: "Anthropic", modelId: "claude-haiku-4-5", label: "Haiku 4.5",
      },
    }]);
    render(<ScheduleEditor schedule={schedule()} onClose={vi.fn()} />);
    await pick("role-selector-trigger", "role-option-auditor");
    await userEvent.click(screen.getByTestId("permission-mode-selector"));
    expect(await screen.findByTestId("permission-mode-option-guarded")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("ScheduleEditor — the rest of a schedule (req 11)", () => {
  it("offers UTC as a time zone, which the browser's own list leaves out", () => {
    render(<ScheduleEditor schedule={schedule({ timeZone: "Europe/Berlin" })} onClose={vi.fn()} />);
    const zones = [...screen.getByTestId("schedule-editor-time-zone").querySelectorAll("option")].map((o) => o.value);
    expect(zones).toContain("UTC");
    expect(zones.filter((zone) => zone === "UTC")).toHaveLength(1);
  });

  it("saves the name, the timing, the time zone, a sandbox target with its grants, and the prompt", async () => {
    const onClose = vi.fn();
    render(<ScheduleEditor schedule={schedule()} onClose={onClose} />);

    fireEvent.change(screen.getByTestId("schedule-editor-name"), { target: { value: "Nightly sweep" } });
    fireEvent.change(screen.getByTestId("schedule-editor-repeats"), { target: { value: "weekly" } });
    fireEvent.change(screen.getByTestId("schedule-editor-weekday"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("schedule-editor-time"), { target: { value: "22:15" } });
    fireEvent.change(screen.getByTestId("schedule-editor-time-zone"), { target: { value: "Europe/Berlin" } });
    fireEvent.change(screen.getByTestId("schedule-editor-target"), { target: { value: "__sandbox__" } });
    await userEvent.click(screen.getByRole("switch", { name: "GitHub access" }));
    fireEvent.change(screen.getByTestId("schedule-editor-prompt"), { target: { value: "Sweep." } });
    await userEvent.click(screen.getByTestId("schedule-editor-save"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved[0]).toEqual({
      name: "Nightly sweep",
      timing: { kind: "weekly", weekday: 3, hour: 22, minute: 15 },
      timeZone: "Europe/Berlin",
      spec: {
        target: { kind: "sandbox", capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: false } },
        params: {},
        prompt: "Sweep.",
      },
    });
  });

  it("leaves out the repository-only parameters when the target is a sandbox", async () => {
    render(
      <ScheduleEditor
        schedule={schedule({
          spec: { target: { kind: "repo", repoUrl: REPO }, params: { networkMode: true, armAutoMerge: true }, prompt: "p" },
        })}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("schedule-editor-target"), { target: { value: "__sandbox__" } });
    expect(screen.queryByTestId("schedule-editor-auto-merge")).toBeNull();
    expect(await savedParams()).toEqual({});
  });

  it("shows the next three run times, and refuses runs less than an hour apart before saving (req 17)", async () => {
    render(<ScheduleEditor schedule={schedule()} onClose={vi.fn()} />);
    expect(screen.getByTestId("schedule-editor-next-runs").textContent?.split("·")).toHaveLength(3);

    fireEvent.change(screen.getByTestId("schedule-editor-repeats"), { target: { value: "cron" } });
    fireEvent.change(screen.getByTestId("schedule-editor-cron"), { target: { value: "*/30 * * * *" } });

    expect(screen.getByTestId("schedule-editor-timing-problem").textContent).toContain("at least an hour apart");
    expect(screen.getByTestId("schedule-editor-save")).toBeDisabled();
  });

  it("shows the server's refusal and stays open", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/schedules/sched-1"
        ? { ok: false, status: 400, json: async () => ({ error: "There is no role named \"auditor\"." }) }
        : { ok: true, status: 200, json: async () => ({ hosts: [] }) }));
    const onClose = vi.fn();
    render(<ScheduleEditor schedule={schedule()} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("schedule-editor-save"));
    expect((await screen.findByTestId("schedule-editor-error")).textContent).toContain("There is no role named");
    expect(onClose).not.toHaveBeenCalled();
  });
});
