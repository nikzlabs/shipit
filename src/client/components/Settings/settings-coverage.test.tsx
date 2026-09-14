/**
 * The residual coverage walk (docs/299-agent-settings-access req 5 and req 7,
 * plan.md → The residual guard).
 *
 * Deriving the dialog's controls from the declarations cannot stop somebody
 * hand-writing one that was never declared, so this renders **each tab of both
 * settings dialogs**, enumerates its interactive elements, and fails on any that
 * is neither a declaration binding nor a reasoned `not-a-setting` exclusion.
 *
 * Four decisions, each because the obvious version of the walk was found wrong:
 *
 *  - **It never matches on `data-testid`.** A test id identifies a control and
 *    proves nothing about whether it shares the declaration's description and
 *    policy — and the MCP env/header editor has no test id at all. The match is
 *    the binding, falling back to the accessible name for an exclusion.
 *  - **It renders the conditional and nested forms**, or it would not see most
 *    of the controls: the MCP stdio *and* HTTP variants, a populated credential
 *    row with its rename and replace fields, an expanded role editor, an
 *    allowlist row mid-edit.
 *  - **It also compares the rendered copy against the declaration**, because a
 *    rendering change that silently drops a description — or quietly writes its
 *    own — is the defect this slice is most likely to ship, and a walk that only
 *    counted controls would stay green through it.
 *  - **It proves it is not passing vacuously.** A tab that rendered nothing has
 *    nothing unaccounted for, so the last test asserts which declarations the
 *    walk actually reached, against a named list of the ones it cannot.
 *
 * Its boundary is the tab **pane**. The dialog's own furniture (the tab strip,
 * the close affordance) is not a setting and is not walked, and neither is the
 * add-a-provider wizard, which is a flow rather than a pane — {@link UNREACHED}
 * names what that costs.
 *
 * **Two things it cannot decide, stated rather than implied.** A bespoke panel
 * keeps its own components by design, so a field there is proved *bound* and its
 * visible wording is a matter for review unless the panel marks it — the
 * standard controls, and the bespoke labels that do mark themselves, are what
 * {@link EXPLAINED_IN_THE_DIALOG} pins. And `wholeTab` is a blanket exemption:
 * on a tab carrying one, nothing can fail, so whether that tab really holds no
 * setting is a claim `exclusions.ts` makes in prose and review checks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings, type SettingsProps } from "../Settings.js";
import { ProjectSettings } from "../ProjectSettings.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useEgressStore } from "../../stores/egress-store.js";
import { useRepoStore } from "../../stores/repo-store.js";
import { useMcpStore } from "../../stores/mcp-store.js";
import {
  ALL_SETTINGS,
  SETTING_EXCLUSIONS,
  findSetting,
  type SettingExclusion,
  type SettingTab,
} from "../../../server/shared/settings-catalogue/index.js";
import type { AgentOption } from "../../agent-types.js";
import type { RoleView, ReviewerSlotView } from "../../../server/shared/types/agent-types.js";

const INTERACTIVE = 'input, select, button, [role="switch"], textarea';

/**
 * Enough of the accessible-name computation for a settings dialog, written here
 * rather than pulled from a dependency: the elements it has to name are labelled
 * boxes, buttons with text, and icon buttons carrying an `aria-label`.
 */
function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const id = el.getAttribute("id");
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const own = el.textContent?.trim();
  if (own) return own;
  const wrapping = el.closest("label");
  if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
  const placeholder = el.getAttribute("placeholder");
  if (placeholder?.trim()) return placeholder.trim();
  return el.getAttribute("title")?.trim() ?? "";
}

function namesOf(exclusion: SettingExclusion): readonly string[] {
  return exclusion.controls ?? [exclusion.label];
}

function describeControl(el: Element): string {
  const testId = el.getAttribute("data-testid");
  return `<${el.tagName.toLowerCase()}${testId ? ` data-testid="${testId}"` : ""}> `
    + `named "${accessibleName(el) || "(nothing)"}"`;
}

/** A control that holds a value of its own, rather than running an operation. */
function editsAValue(el: Element): boolean {
  return ["input", "select", "textarea"].includes(el.tagName.toLowerCase());
}

/** Every control in a pane, ignoring anything already hidden from a reader. */
function controlsIn(pane: Element): Element[] {
  return [...pane.querySelectorAll(INTERACTIVE)].filter(
    (el) => !el.closest('[aria-hidden="true"]') && el.getAttribute("type") !== "hidden",
  );
}

interface WalkResult {
  /** Controls that are neither a declaration binding nor a reasoned exclusion. */
  readonly unaccounted: string[];
  /** Rendered copy that is not the declaration's own words. */
  readonly drift: string[];
  /** Declarations this pane actually rendered a control for. */
  readonly bound: Set<string>;
  /** Declarations whose label AND description this pane rendered. */
  readonly explained: Set<string>;
}

function walk(pane: Element, tab: SettingTab): WalkResult {
  const exclusions = SETTING_EXCLUSIONS.filter((x) => x.tab === tab);
  const wholeTab = exclusions.some((x) => x.wholeTab);
  const excused = new Set(exclusions.flatMap(namesOf));
  const unaccounted: string[] = [];
  const bound = new Set<string>();

  for (const el of controlsIn(pane)) {
    const key = el.getAttribute("data-setting");
    if (key) {
      const declaration = findSetting(key);
      if (!declaration) {
        unaccounted.push(`${describeControl(el)} binds undeclared "${key}"`);
      } else if (declaration.type.kind === "collection" && editsAValue(el)) {
        /*
          plan.md → Bespoke panels declare per field. A collection's controls are
          its declared operations — add, remove, reorder — and those are buttons.
          A box that edits a VALUE is a field, and a field binds to its own
          declaration; binding it to the collection is exactly the per-panel
          loophole one entry per panel would have left open.
        */
        unaccounted.push(`${describeControl(el)} edits a value but binds the collection "${key}"`);
      } else {
        bound.add(key);
      }
      continue;
    }
    if (!wholeTab && !excused.has(accessibleName(el))) unaccounted.push(describeControl(el));
  }

  const drift: string[] = [];
  const rendered: Record<"label" | "description", Set<string>> = {
    label: new Set(),
    description: new Set(),
  };
  for (const [attribute, field] of [
    ["data-setting-label", "label"],
    ["data-setting-description", "description"],
  ] as const) {
    for (const el of pane.querySelectorAll(`[${attribute}]`)) {
      const key = el.getAttribute(attribute) ?? "";
      const declaration = findSetting(key);
      if (!declaration) {
        drift.push(`${attribute}="${key}" names no declaration`);
        continue;
      }
      const text = el.textContent?.trim() ?? "";
      if (text === declaration[field]) rendered[field].add(key);
      else {
        drift.push(
          `${key} ${field}: rendered ${JSON.stringify(text)}, `
          + `declared ${JSON.stringify(declaration[field])}`,
        );
      }
    }
  }
  const explained = new Set([...rendered.label].filter((key) => rendered.description.has(key)));

  return { unaccounted, drift, bound, explained };
}

// ---------------------------------------------------------------- fixtures

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
    reasoning: {
      label: "Reasoning",
      options: [
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
    },
  },
  // A SECOND harness carrying the same model, so the role editor's harness
  // control is a picker rather than the readout it renders when there is no
  // choice — otherwise `roles[].harness` has no control for the walk to find.
  {
    id: "codex",
    name: "Codex",
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
  },
];

const resolvedOpus = {
  serviceId: "anthropic",
  serviceName: "Anthropic",
  billingMode: "sub" as const,
  modelId: "claude-opus-5",
  label: "Opus 5",
  harnessId: "claude" as const,
  harnessName: "Claude Code",
  reasoningEffort: "high",
  reasoningLabel: "High",
};

const pinnedRole: RoleView = {
  name: "deep-dive",
  description: "Deep research",
  prompt: "Report only.",
  reserved: false,
  params: {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  },
  resolved: resolvedOpus,
};

const reviewerRole: RoleView = {
  name: "reviewer",
  description: "The second opinion",
  reserved: true,
  params: { kind: "auto" },
};

/** One auto slot and one pinned, because *Reset to auto* only exists on a pin. */
const reviewerSlots: ReviewerSlotView[] = [
  { slot: "first", source: "auto", resolved: resolvedOpus },
  {
    slot: "second",
    source: "pinned",
    pin: {
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
    },
    resolved: resolvedOpus,
  },
];

const settingsProps: SettingsProps = {
  initialContent: "",
  initialOpsContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: true, username: "nik" },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  agentList: agents,
  gitIdentity: { name: "Nik", email: "nik@example.com" },
  onGitIdentitySave: vi.fn(),
  memoryBudgetMb: null,
  onMemoryBudgetSave: vi.fn(),
  agentSystemInstructionsEnabled: true,
  agentSystemInstructions: "You are working inside ShipIt.",
  onToggleAgentSystemInstructions: vi.fn(),
  hasActiveSession: true,
  onClose: vi.fn(),
};

const REPO_URL = "https://github.com/acme/app";

function seedStores() {
  const now = Date.now();
  useSettingsStore.getState().setCredentialRoutes([
    {
      id: "route-a", serviceId: "anthropic", billingMode: "sub", via: "string",
      label: "Anthropic (primary)", isPrimary: true, status: "ready", createdAt: now, updatedAt: now,
    },
    {
      id: "route-b", serviceId: "anthropic", billingMode: "sub", via: "string",
      label: "Anthropic (backup)", isPrimary: false, status: "ready", createdAt: now, updatedAt: now,
    },
  ]);
  /*
    A connected provider account, on a DIFFERENT service from the two string
    credentials above: an account and a string on one mode is a mixed card,
    which offers no order and no routing band, and the routing controls are what
    the services walk is there to reach.
  */
  useSettingsStore.getState().setProviderAccounts([
    {
      id: "acct-1", serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account", isPrimary: true, status: "ready", createdAt: now, updatedAt: now,
    },
  ]);
  useSettingsStore.getState().setBackgroundWorkModels(agents[0].eligibleModels ?? []);
  useSettingsStore.getState().setRoles([pinnedRole, reviewerRole]);
  useSettingsStore.getState().setReviewers(reviewerSlots);
  useSettingsStore.setState({
    // A binding the user changed, so the per-row reset control exists.
    keybindings: { "voice-mode-a": "Ctrl+Shift+Space" },
    // External delivery, so the webhook fields are on screen at all.
    voiceDeliveryMode: "both",
  });
  useMcpStore.setState({
    servers: [
      { name: "local", type: "stdio", command: "npx", args: ["-y", "pkg"], enabled: true },
      { name: "remote", type: "http", url: "https://mcp.example.com/mcp", enabled: true },
    ],
    loading: false,
    oauthProviders: [
      {
        id: "sentry",
        label: "Sentry",
        mcpUrl: "https://mcp.sentry.dev/mcp",
        defaultServerName: "sentry",
        status: { source: "sentry", connected: false },
      },
    ],
  });
  useEgressStore.setState({
    loaded: true,
    globalEnabled: true,
    enforcementActive: true,
    defaultsCustomized: true,
    entries: [
      { host: "api.example.com", source: "user-global", removable: true },
      { host: "registry.npmjs.org", source: "operator", removable: false },
    ],
  });
  usePreviewStore.getState().setSecrets({
    declared: [{ name: "DATABASE_URL", services: ["db"], required: true }],
    missingByService: {},
    missingRequired: [],
  });
  useRepoStore.setState({
    repos: [{ url: REPO_URL, name: "app", colorIndex: 2, allowAgentMerge: false }],
  } as never);
}

beforeEach(() => {
  // Offline on purpose: every panel loads its own external state on mount, and
  // the walk is about what the dialog renders from the stores it is handed.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline in this test")));
  seedStores();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.getState().setSettingsTab(undefined);
  useSettingsStore.getState().setCredentialRoutes([]);
  useSettingsStore.getState().setProviderAccounts([]);
  useSettingsStore.getState().setRoles([]);
  useSettingsStore.getState().setReviewers([]);
  useSettingsStore.setState({ keybindings: {}, voiceDeliveryMode: "native" });
  useMcpStore.setState({ servers: [], oauthProviders: [] });
  useEgressStore.setState({ entries: [], loaded: false, defaultsCustomized: false });
  usePreviewStore.getState().setSecrets({ declared: [], missingByService: {}, missingRequired: [] });
  useRepoStore.setState({ repos: [] } as never);
});

// ------------------------------------------------------------------ renders

/** The pane the walk reads: the one tab Radix currently has mounted. */
function activePane(): HTMLElement {
  return screen.getByRole("tabpanel");
}

/**
 * Skills is absent from the walk because its exclusion covers the whole tab —
 * discover-only, installs through a pull request in a session of its own, no
 * stored value. The test below pins that the two lists agree, so the tab cannot
 * be skipped without the catalogue saying, in prose, why.
 */
/** Every tab the global dialog renders, in its own order. */
const SETTINGS_DIALOG_TABS: SettingTab[] = [
  "services", "roles", "integrations", "git", "instructions",
  "skills", "keyboard", "voice", "network", "advanced",
];

const GLOBAL_TABS: SettingTab[] = SETTINGS_DIALOG_TABS.filter((tab) => tab !== "skills");

const PROJECT_TABS: { tab: SettingTab; initial: "secrets" | "deployments" | "appearance" }[] = [
  { tab: "project-secrets", initial: "secrets" },
  { tab: "project-deployments", initial: "deployments" },
  { tab: "project-appearance", initial: "appearance" },
];

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

async function renderGlobalTab(tab: SettingTab): Promise<HTMLElement> {
  act(() => { useUiStore.getState().setSettingsTab(tab as never); });
  render(<Settings {...settingsProps} />);
  await settle();
  return activePane();
}

async function renderProjectTab(
  initial: "secrets" | "deployments" | "appearance",
): Promise<HTMLElement> {
  render(
    <ProjectSettings
      repoUrl={REPO_URL}
      repoName="app"
      initialTab={initial}
      onSecretsLoad={async () => ["LEGACY_TOKEN"]}
      onSecretsSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await settle();
  return activePane();
}

/** Opens the role editor on the pinned role and returns its dialog. */
async function openRoleEditor(): Promise<HTMLElement> {
  await renderGlobalTab("roles");
  await userEvent.click(screen.getByTestId("role-open-deep-dive"));
  return screen.findByTestId("role-editor");
}

/** Opens a credential or account row's overflow menu and picks one operation. */
async function openRowField(row: string, item: string): Promise<HTMLElement> {
  const pane = await renderGlobalTab("services");
  await userEvent.click(within(pane).getByRole("button", { name: `Manage ${row}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
  return pane;
}

/** The row operations that open a field of their own, and the row they open on. */
const ROW_FIELDS: readonly [row: string, item: string][] = [
  ["Anthropic (primary)", "Rename"],
  ["Anthropic (primary)", "Replace secret"],
  ["OpenAI account", "Rename"],
];

/**
 * Opens the MCP form and walks each transport in turn, with one secret row
 * present — an empty environment list renders no inputs at all, so a walk that
 * did not add a row would never see the fields it claims to cover.
 */
async function walkBothMcpTransports(pane: HTMLElement): Promise<WalkResult[]> {
  const form = () => screen.getByTestId("mcp-server-form");
  const addSecretRow = async (noun: "variable" | "header") => {
    await userEvent.click(within(form()).getByRole("button", { name: `+ Add ${noun}` }));
    expect(within(form()).getAllByLabelText(/— name 1$/)).toHaveLength(1);
  };

  await userEvent.click(screen.getByTestId("mcp-add-server"));
  await addSecretRow("variable");
  const stdio = walk(pane, "integrations");

  await userEvent.selectOptions(form().querySelector("select")!, "http");
  expect(form().textContent).toContain("URL");
  await addSecretRow("header");
  return [stdio, walk(pane, "integrations")];
}

// -------------------------------------------------------------------- tests

describe("every control in the Settings dialog is declared or excused", () => {
  for (const tab of GLOBAL_TABS) {
    it(`accounts for the ${tab} tab`, async () => {
      expect(walk(await renderGlobalTab(tab), tab).unaccounted).toEqual([]);
    });
  }

  it("leaves out only a tab that carries a whole-tab exemption", () => {
    const walked = new Set(GLOBAL_TABS);
    const exempt = new Set(
      SETTING_EXCLUSIONS.filter((x) => x.wholeTab).map((x) => x.tab),
    );
    // Skills is the only tab either list may name, and it must be in both: left
    // out of the walk AND excused in the catalogue, with the reason written down.
    expect([...exempt]).toEqual(["skills"]);
    expect(SETTINGS_DIALOG_TABS.filter((tab) => !walked.has(tab))).toEqual([...exempt]);
  });

  it("accounts for the role editor, which only exists once opened", async () => {
    expect(walk(await openRoleEditor(), "roles").unaccounted).toEqual([]);
  });

  it("accounts for the fields a credential or account row opens", async () => {
    for (const [row, item] of ROW_FIELDS) {
      expect(walk(await openRowField(row, item), "services").unaccounted).toEqual([]);
      cleanup();
    }
  });

  it("accounts for both MCP transports, whose forms render different fields", async () => {
    const pane = await renderGlobalTab("integrations");
    for (const result of await walkBothMcpTransports(pane)) {
      expect(result.unaccounted).toEqual([]);
    }
  });

  it("accounts for an allowlist row mid-edit", async () => {
    const pane = await renderGlobalTab("network");
    await userEvent.click(screen.getByTestId("settings-egress-edit-api.example.com"));
    expect(screen.getByTestId("settings-egress-edit-input-api.example.com")).toBeInTheDocument();
    expect(walk(pane, "network").unaccounted).toEqual([]);
  });
});

describe("every control in the Project Settings dialog is declared or excused", () => {
  for (const { tab, initial } of PROJECT_TABS) {
    it(`accounts for the ${initial} tab`, async () => {
      expect(walk(await renderProjectTab(initial), tab).unaccounted).toEqual([]);
    });
  }
});

describe("the dialog's copy is the declaration's copy", () => {
  for (const tab of GLOBAL_TABS) {
    it(`writes none of its own on the ${tab} tab`, async () => {
      expect(walk(await renderGlobalTab(tab), tab).drift).toEqual([]);
    });
  }

  for (const { tab, initial } of PROJECT_TABS) {
    it(`writes none of its own on the project ${initial} tab`, async () => {
      expect(walk(await renderProjectTab(initial), tab).drift).toEqual([]);
    });
  }

  it("writes none of its own in the role editor", async () => {
    expect(walk(await openRoleEditor(), "roles").drift).toEqual([]);
  });
});

/**
 * Declarations whose control this walk cannot reach, each with the reason. A
 * declaration missing from the walk AND from here fails the test below, so a
 * control that quietly stops being rendered cannot pass as coverage.
 */
const UNREACHED: Record<string, string> = {
  "services.providerAccounts[].connection": "Its controls are the sign-in challenge, which "
    + "`AccountChallenge` renders inside the add-a-provider wizard and nowhere else "
    + "(`ProviderAccountRows.tsx`). The wizard is a flow rather than a pane.",
};

/**
 * The settings the dialog explains **in the declaration's own words** — both the
 * label and the description, rendered from `ALL_SETTINGS` (req 7).
 *
 * Listed rather than counted, because the drift check above can only compare copy
 * that is still on screen: deleting a description outright leaves nothing to
 * compare, and the control stays bound, so nothing else would go red. A setting
 * that stops explaining itself drops out of this list and fails, and a control
 * that starts explaining itself is a one-line addition here.
 */
const EXPLAINED_IN_THE_DIALOG: readonly string[] = [
  "advanced.autoFixCi",
  "advanced.autoResetMergedBranch",
  "advanced.autoResolveConflicts",
  "advanced.compactConversation",
  "advanced.enableSubAgents",
  "advanced.liveSteering",
  "advanced.memoryBudgetMb",
  "advanced.notifyOnFinish",
  "advanced.releaseChannel",
  "advanced.soundOnFinish",
  "instructions.agentInstructionsEnabled",
  "instructions.opsInstructions",
  "instructions.userInstructions",
  "integrations.autoCreatePr",
  "network.egress.hosts",
  "network.egressContained",
  "project.allowAgentMerge",
  "project.colorIndex",
  "reviewers",
  "roles",
  "roles[].description",
  "roles[].model",
  "roles[].name",
  "roles[].prompt",
  "services.nonTurnModel",
  "voice.cleanupEnabled",
  "voice.deliveryMode",
  "voice.handsFree",
  "voice.inputEnabled",
  "voice.language",
  "voice.playbackEnabled",
  "voice.sttProvider",
  "voice.ttsProvider",
  "voice.ttsSpeed",
  "voice.ttsVoice",
];

describe("the walk is not passing vacuously", () => {
  it("reaches every declaration except the ones named as unreachable", async () => {
    const seen = new Set<string>();
    const explained = new Set<string>();
    const record = (...results: WalkResult[]) => {
      for (const result of results) {
        for (const key of result.bound) seen.add(key);
        for (const key of result.explained) explained.add(key);
      }
    };

    for (const tab of GLOBAL_TABS) {
      record(walk(await renderGlobalTab(tab), tab));
      cleanup();
    }
    for (const { tab, initial } of PROJECT_TABS) {
      record(walk(await renderProjectTab(initial), tab));
      cleanup();
    }
    record(walk(await openRoleEditor(), "roles"));
    cleanup();
    for (const [row, item] of ROW_FIELDS) {
      record(walk(await openRowField(row, item), "services"));
      cleanup();
    }
    record(...await walkBothMcpTransports(await renderGlobalTab("integrations")));
    cleanup();
    {
      const pane = await renderGlobalTab("network");
      await userEvent.click(screen.getByTestId("settings-egress-edit-api.example.com"));
      record(walk(pane, "network"));
      cleanup();
    }

    const missing = ALL_SETTINGS.map((d) => d.key).filter((key) => !seen.has(key));
    expect(missing.sort()).toEqual(Object.keys(UNREACHED).sort());
    expect([...explained].sort()).toEqual([...EXPLAINED_IN_THE_DIALOG].sort());
  });
});
