import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RolesTab } from "./RolesTab.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import type { AgentOption } from "../../../agent-types.js";
import type { RoleView } from "../../../../server/shared/types/agent-types.js";

/**
 * docs/264 phase 2 (reqs 1, 2, 5, 6, 8, 9, 17, 18) — what the Settings surface
 * has to make true.
 *
 * The demanding ones are req 6 and the unresolved view, and both are places a
 * picker-based UI goes wrong by default:
 *
 *  - **req 6** — a model carried by TWO harnesses needs a real picker, because
 *    nothing else can say which harness the role means. The fixture below has
 *    one (`deepseek-v4`, on both installed agents) and one that is single-harness
 *    (`claude-opus-5`), so the two branches are pinned against each other rather
 *    than against a hand-waved "some model".
 *  - **the unresolved role** — with no eligible row to match, a resolution-only
 *    list would either drop the row or silently show the first available value.
 *    It has to render the RAW stored tuple and keep both controls, or a role
 *    whose model was retired can never be repaired.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-opus-5", "deepseek-v4-flash"],
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
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
        canonicalModelKey: "deepseek-v4-flash",
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
    // The dual-harness half of the pair: the SAME DeepSeek triple, on the second
    // installed harness. The ids are the SHIPPED ones — `deepseek-v4-flash` is
    // really carried by both harnesses — so this fixture mirrors a real row
    // rather than inventing the case it tests. The catalogue itself is pinned
    // server-side, where the rules live (`role-settings.test.ts`,
    // `role-settings-api.test.ts` both drive the real catalogue).
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-v4-flash"],
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
        canonicalModelKey: "deepseek-v4-flash",
      },
    ],
    supportsReview: true,
    reasoning: {
      label: "Reasoning effort",
      options: [
        { value: "minimal", label: "Minimal" },
        { value: "high", label: "High" },
      ],
    },
  },
];

const REVIEWER: RoleView = { name: "reviewer", params: { kind: "auto" }, reserved: true };

function pinnedRole(over: Partial<RoleView> = {}): RoleView {
  return {
    name: "deep-dive",
    description: "The thorough one",
    reserved: false,
    params: {
      kind: "pinned",
      harnessId: "claude",
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
    },
    resolved: {
      harnessId: "claude",
      harnessName: "Claude Code",
      serviceId: "deepseek",
      billingMode: "key",
      serviceName: "DeepSeek",
      modelId: "deepseek-v4-flash",
      label: "V4 Flash",
      reasoningEffort: "max",
      reasoningLabel: "Max",
    },
    ...over,
  };
}

/** A PUT that echoes the roles back, as the real route does. */
function okFetch(roles: RoleView[] = []) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ roles }) }));
}

function refusingFetch(error: string) {
  return vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error }) }));
}

function urlOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  return (fetchMock.mock.calls[call] as unknown as [string])[0];
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const args = fetchMock.mock.calls[call] as unknown as [string, { body: string }];
  return JSON.parse(args[1].body) as Record<string, unknown>;
}

/** The one role the request wrote, whatever its name. */
function writtenRole(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const roles = bodyOf(fetchMock, call).roles as Record<string, unknown>;
  const [name, write] = Object.entries(roles)[0];
  return { name, write: write as Record<string, unknown> | null };
}

beforeEach(() => {
  useSettingsStore.getState().setReviewers([]);
  useSettingsStore.getState().setRoles([REVIEWER]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---- The list (reqs 5, 9, 17) ----------------------------------------------

describe("RolesTab — the list", () => {
  it("keeps the reviewer out of the role list and gives it no rename or delete (req 2)", () => {
    useSettingsStore.getState().setRoles([REVIEWER, pinnedRole()]);
    render(<RolesTab agentList={agents} />);

    expect(screen.queryByTestId("role-row-reviewer")).toBeNull();
    expect(screen.queryByTestId("role-delete-reviewer")).toBeNull();
    // Its own section is still there, with both docs/261 slot cards.
    expect(screen.getByTestId("reviewer-tab")).toBeTruthy();
    expect(screen.getByTestId("reviewer-metadata")).toBeTruthy();
  });

  it("renders a role as a SUMMARY — name, description, what it resolves to (req 17)", () => {
    useSettingsStore.getState().setRoles([REVIEWER, pinnedRole()]);
    render(<RolesTab agentList={agents} />);

    const row = screen.getByTestId("role-row-deep-dive");
    expect(row.textContent).toContain("deep-dive");
    expect(row.textContent).toContain("The thorough one");
    const resolution = screen.getByTestId("role-resolution-deep-dive").textContent ?? "";
    expect(resolution).toContain("DeepSeek");
    expect(resolution).toContain("V4 Flash");
    expect(resolution).toContain("Claude Code");
    expect(resolution).toContain("Max");
    // A summary, not a row of controls: no service/model/level pickers here.
    expect(screen.queryByTestId("role-editor-model-trigger")).toBeNull();
  });

  it("says the install has no roles yet without hiding the reviewer", () => {
    render(<RolesTab agentList={agents} />);
    expect(screen.getByTestId("roles-empty")).toBeTruthy();
    expect(screen.getByTestId("reviewer-metadata")).toBeTruthy();
  });

  it("deletes a role through the settings mutation surface", async () => {
    const fetchMock = okFetch([REVIEWER]);
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setRoles([REVIEWER, pinnedRole()]);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-delete-deep-dive"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(urlOf(fetchMock)).toBe("/api/settings");
    expect(writtenRole(fetchMock)).toEqual({ name: "deep-dive", write: null });
    // The server's answer replaces the list — nothing here is optimistic.
    await waitFor(() => expect(useSettingsStore.getState().roles).toEqual([REVIEWER]));
  });
});

describe("RolesTab — a failed write is ambiguous, so the list is re-read", () => {
  it("re-reads the roles from the server after a refused write", async () => {
    // The rename committed and its response was lost. Without the re-read the
    // editor would keep offering to retry under a `previousName` the server no
    // longer knows — refused every time, with a reload the only way out.
    const renamed: RoleView = { ...pinnedRole(), name: "deeper-dive" };
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/bootstrap"
        ? { ok: true, json: async () => ({ settings: { roles: [REVIEWER, renamed] } }) }
        : { ok: false, status: 500, json: async () => ({ error: "connection lost" }) },
    );
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setRoles([REVIEWER, pinnedRole()]);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-open-deep-dive"));
    await userEvent.clear(screen.getByTestId("role-editor-name"));
    await userEvent.type(screen.getByTestId("role-editor-name"), "deeper-dive");
    await userEvent.click(screen.getByTestId("role-editor-save"));

    // The error stays where the user is, AND the list stops holding a guess.
    await waitFor(() => expect(screen.getByTestId("role-editor-error")).toBeTruthy());
    await waitFor(() =>
      expect(useSettingsStore.getState().roles.map((r) => r.name)).toEqual([
        "reviewer",
        "deeper-dive",
      ]),
    );
  });
});

// ---- The unresolved role ----------------------------------------------------

describe("RolesTab — a role that cannot run stays visible and editable", () => {
  const stranded = pinnedRole({
    name: "gone",
    resolved: undefined,
    unavailableReason: "stranded",
    invalidField: "model",
    params: {
      kind: "pinned",
      harnessId: "claude",
      serviceId: "retired-service",
      billingMode: "key",
      modelId: "retired-model",
      reasoningEffort: "max",
    },
  });

  it("renders the RAW stored tuple, names the invalid field, and keeps both controls", () => {
    useSettingsStore.getState().setRoles([REVIEWER, stranded]);
    render(<RolesTab agentList={agents} />);

    const resolution = screen.getByTestId("role-resolution-gone").textContent ?? "";
    expect(resolution).toContain("retired-service");
    expect(resolution).toContain("retired-model");
    expect(screen.getByTestId("role-unavailable-gone").textContent).toContain("model");
    expect(screen.getByTestId("role-open-gone")).toBeTruthy();
    expect(screen.getByTestId("role-delete-gone")).toBeTruthy();
  });

  it("opens the editor on the stored tuple rather than the first available option", async () => {
    useSettingsStore.getState().setRoles([REVIEWER, stranded]);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-open-gone"));
    // The service and model the role actually holds — NOT DeepSeek, which is
    // what a picker with no matching option would have silently shown.
    expect(screen.getByTestId("role-editor-service-trigger").textContent).toContain(
      "retired-service",
    );
    expect(screen.getByTestId("role-editor-model-trigger").textContent).toContain("retired-model");
  });

  it("tells a disconnected role's user to reconnect the SERVICE, not to edit the role", () => {
    useSettingsStore.getState().setRoles([
      REVIEWER,
      pinnedRole({ name: "quiet", resolved: undefined, unavailableReason: "disconnected" }),
    ]);
    render(<RolesTab agentList={agents} />);

    const detail = screen.getByTestId("role-unavailable-quiet").textContent ?? "";
    expect(detail).toContain("reconnect");
    expect(detail).not.toContain("edit the role");
  });

  it("tells a quota-exhausted role's user there is nothing to fix", () => {
    useSettingsStore.getState().setRoles([
      REVIEWER,
      pinnedRole({ name: "spent", resolved: undefined, unavailableReason: "quota_exhausted" }),
    ]);
    render(<RolesTab agentList={agents} />);
    expect(screen.getByTestId("role-unavailable-spent").textContent).toContain("Nothing to fix");
  });
});

// ---- The editor (reqs 6, 8, 9, 17, 18) -------------------------------------

describe("RoleEditor — one place editing the whole role (req 17)", () => {
  it("creates a role with its name, description, instructions and params in one write", async () => {
    const fetchMock = okFetch([REVIEWER]);
    vi.stubGlobal("fetch", fetchMock);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-new"));
    await userEvent.type(screen.getByTestId("role-editor-name"), "deep dive");
    await userEvent.type(screen.getByTestId("role-editor-description"), "for the hard ones");
    await userEvent.type(screen.getByTestId("role-editor-prompt"), "Read requirements.md first");
    await userEvent.click(screen.getByTestId("role-editor-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const { name, write } = writtenRole(fetchMock);
    // Any name the user typed, spaces and all (req 18).
    expect(name).toBe("deep dive");
    expect(write).toMatchObject({
      description: "for the hard ones",
      prompt: "Read requirements.md first",
      params: { kind: "pinned", harnessId: "claude" },
    });
    // A create carries no previousName — that is what lets the server refuse a
    // name that is already taken instead of overwriting it.
    expect(write?.previousName).toBeUndefined();
  });

  it("renames through the editor, carrying the previous name (req 18)", async () => {
    const fetchMock = okFetch([REVIEWER]);
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setRoles([REVIEWER, pinnedRole()]);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-open-deep-dive"));
    await userEvent.clear(screen.getByTestId("role-editor-name"));
    await userEvent.type(screen.getByTestId("role-editor-name"), "deeper-dive");
    await userEvent.click(screen.getByTestId("role-editor-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const { name, write } = writtenRole(fetchMock);
    expect(name).toBe("deeper-dive");
    expect(write?.previousName).toBe("deep-dive");
  });

  it("keeps the server's refusal beside the controls, and the editor open", async () => {
    const fetchMock = refusingFetch('The role "deep dive" cannot run: "max" is not a level Codex offers.');
    vi.stubGlobal("fetch", fetchMock);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-new"));
    await userEvent.type(screen.getByTestId("role-editor-name"), "deep dive");
    await userEvent.click(screen.getByTestId("role-editor-save"));

    await waitFor(() =>
      expect(screen.getByTestId("role-editor-error").textContent).toContain("Codex offers"),
    );
    expect(screen.getByTestId("role-editor")).toBeTruthy();
  });

});

// ---- The harness reaches the wire (req 6) ----------------------------------

/**
 * The harness *control* is `RoleEditor.test.tsx`'s subject — picker where a
 * model has a choice, readout where it has one, stored id where it has none.
 * What belongs here is the other half: that the harness the user picked is what
 * the settings write actually carries.
 */
describe("RolesTab — the harness the user picked is what gets written", () => {
  it("writes the chosen harness, with a level that harness declares", async () => {
    const fetchMock = okFetch([REVIEWER]);
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setRoles([REVIEWER, pinnedRole()]);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("role-open-deep-dive"));
    await userEvent.click(screen.getByTestId("role-editor-harness-trigger"));
    await userEvent.click(screen.getByTestId("role-editor-harness-option-codex"));
    await userEvent.click(screen.getByTestId("role-editor-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // `max` is Claude Code's level and not Codex's, so the draft moved onto one
    // Codex declares rather than sending a tuple the server would refuse.
    expect(writtenRole(fetchMock).write?.params).toMatchObject({
      harnessId: "codex",
      reasoningEffort: "minimal",
    });
  });
});

// ---- The reviewer's own editor (reqs 2, 8, 9) -------------------------------

describe("RoleEditor — the reviewer", () => {
  it("edits its description and standing instructions and nothing else", async () => {
    const fetchMock = okFetch([REVIEWER]);
    vi.stubGlobal("fetch", fetchMock);
    render(<RolesTab agentList={agents} />);

    await userEvent.click(screen.getByTestId("reviewer-edit"));
    // No name field at all — the reserved name is not a setting (req 2).
    expect(screen.queryByTestId("role-editor-name")).toBeNull();
    // And no params: they are the two ranked slot cards behind the dialog.
    expect(screen.queryByTestId("role-editor-model-trigger")).toBeNull();
    expect(screen.getByTestId("role-editor-auto-note")).toBeTruthy();

    await userEvent.type(screen.getByTestId("role-editor-description"), "Second opinion");
    await userEvent.click(screen.getByTestId("role-editor-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const { name, write } = writtenRole(fetchMock);
    expect(name).toBe("reviewer");
    expect(write).toMatchObject({
      previousName: "reviewer",
      description: "Second opinion",
      params: { kind: "auto" },
    });
  });

  it("shows its description and standing instructions above the slot cards", () => {
    useSettingsStore.getState().setRoles([
      { ...REVIEWER, description: "Second opinion", prompt: "Review only; do not edit" },
    ]);
    render(<RolesTab agentList={agents} />);
    expect(screen.getByTestId("reviewer-description").textContent).toBe("Second opinion");
    expect(screen.getByTestId("reviewer-prompt").textContent).toBe("Review only; do not edit");
  });
});
