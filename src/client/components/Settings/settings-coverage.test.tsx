/**
 * The residual coverage walk (docs/299-agent-settings-access req 5 and req 7,
 * plan.md → The residual guard).
 *
 * Deriving the dialog's controls from the declarations cannot stop somebody
 * hand-writing one that was never declared, so this renders each tab of both
 * settings dialogs and fails on any interactive element that is neither a
 * declaration binding nor a reasoned `not-a-setting` exclusion. It matches the
 * binding and falls back to the accessible name; never a test id, which
 * identifies a control without proving it shares the declaration's description
 * and policy.
 *
 * **It opens what the pane can open, rather than what somebody listed.** The
 * nested forms used to be reached by name — the role editor, the MCP form, a
 * credential row's rename — which meant the SSH add-a-destination form was
 * simply never opened and its four boxes were controls no test could fail on.
 * {@link crawl} presses every trigger in scope instead and walks whatever
 * appears, so a form nobody names is still walked; its doc comment states the
 * three bounds that are real.
 *
 * Its boundary is the tab **pane and what the pane discloses**, never the whole
 * document, so the dialog's own furniture stays out; {@link UNREACHED} names any
 * declaration that ends up with no control the crawl can reach. Two things it
 * cannot decide — a bespoke panel's visible wording unless the panel marks it,
 * and whether a `wholeTab` or `region` exemption is honest — are claims made in
 * prose and checked by review.
 *
 * **And a third, which is not prose but a different guard.** This walk reads the
 * rendered DOM, so it can establish that a control names *a* declaration and
 * never that the declaration is the one whose property the handler saves: a new
 * box bound to `mcp.servers[].command` while writing something else passes here.
 * What the DOM cannot say, the STORED TYPE can —
 * `MCP_SERVER_FIELD_SETTINGS` (`settings-catalogue/integrations-settings.ts`) is
 * keyed by `keyof McpServerConfig`, so a field added to the persisted shape is a
 * compile error until it is declared or explained. The two guards run in
 * opposite directions: this one finds a control nobody declared, that one finds
 * a stored field nobody declared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SETTINGS_TABS, Settings, type SettingsProps } from "../Settings.js";
import { PROJECT_SETTINGS_TABS, ProjectSettings } from "../ProjectSettings.js";
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

const INTERACTIVE =
  'input, select, button, textarea, [role="switch"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/**
 * Pressable, and NOT part of what the walk accounts for: a plain menu item picks
 * one of a collection's operations, and the menu's trigger is what binds the
 * collection (see {@link editsAValue}). The crawl has to press them — the rename
 * and replace-secret fields of a credential row exist only behind one — but
 * requiring each to name a declaration would make "Rename" a setting.
 *
 * A menu item that CARRIES a value is a different thing and is in `INTERACTIVE`
 * above: `menuitemcheckbox` and `menuitemradio` are accounted like any other
 * control, so the exemption cannot be widened by rendering a setting as one.
 */
const OPERATION_CHOOSER = '[role="menuitem"]';

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

/**
 * Whether a control is inside a container the catalogue excuses whole.
 *
 * It answers two questions with one rule. The walk asks it because every control
 * in such a container is that one exclusion; the crawl asks it because there is
 * then nothing in there to discover, and the supported-models dialog alone
 * renders one filter per (service, billing mode, harness) the catalogue holds —
 * eighty-odd presses that reveal the same read-only list each time and starve
 * the rest of the tab. The cost is that a form opened from INSIDE an excused
 * region is not reached, which the region's `why` has to be true enough to rule
 * out.
 */
function excusedRegionOf(tab: SettingTab): (el: Element) => boolean {
  const regions = SETTING_EXCLUSIONS
    .filter((x) => x.tab === tab)
    .map((x) => x.region)
    .filter((id) => id !== undefined);
  if (regions.length === 0) return () => false;
  const selector = regions.map((id) => `[data-testid="${id}"]`).join(", ");
  return (el) => el.closest(selector) !== null;
}

function describeControl(el: Element): string {
  const testId = el.getAttribute("data-testid");
  return `<${el.tagName.toLowerCase()}${testId ? ` data-testid="${testId}"` : ""}> `
    + `named "${accessibleName(el) || "(nothing)"}"`;
}

/**
 * A control that holds a value of its own, rather than running an operation.
 *
 * Not the tag alone: a switch, a radio and a toggle button are all `<button>`,
 * and binding one of those to a collection is the same loophole as an `<input>`.
 * A menu trigger looks the same and is NOT one — the overflow menu on a
 * credential row offers the collection's operations, which is what it should
 * bind — so the test is the checked/pressed state a value control carries.
 */
function editsAValue(el: Element): boolean {
  return ["input", "select", "textarea"].includes(el.tagName.toLowerCase())
    || el.hasAttribute("aria-checked")
    || el.hasAttribute("aria-pressed");
}

function visible(el: Element): boolean {
  return !el.closest('[aria-hidden="true"]') && el.getAttribute("type") !== "hidden";
}

/** Every control in a pane, ignoring anything already hidden from a reader. */
function controlsIn(root: ParentNode): Element[] {
  return [...root.querySelectorAll(INTERACTIVE)].filter(visible);
}

/** The operation pickers in a pane: pressed by the crawl, accounted by nothing. */
function choosersIn(root: ParentNode): Element[] {
  return [...root.querySelectorAll(OPERATION_CHOOSER)].filter(visible);
}

const COPY_ATTRS = "[data-setting-label], [data-setting-description]";

/**
 * What one walk looks at: the controls, and the elements claiming to render a
 * declaration's words.
 *
 * Held as node lists rather than as a root, because a disclosure is found by
 * DIFFING the document — the form a button opens may render inside the pane or
 * in a portal beside it, and the only thing both have in common is that their
 * nodes were not there before the click.
 */
interface Surface {
  readonly controls: Element[];
  readonly copy: Element[];
  /** Pressed by the crawl, and never walked. */
  readonly choosers: Element[];
}

function surfaceOf(root: ParentNode): Surface {
  return {
    controls: controlsIn(root),
    copy: [...root.querySelectorAll(COPY_ATTRS)].filter(visible),
    choosers: choosersIn(root),
  };
}

const EMPTY_SURFACE: Surface = { controls: [], copy: [], choosers: [] };

function mergeSurfaces(a: Surface, b: Surface): Surface {
  const join = (one: Element[], two: Element[]): Element[] => {
    const held = new Set(one);
    return [...one, ...two.filter((el) => !held.has(el))];
  };
  return {
    controls: join(a.controls, b.controls),
    copy: join(a.copy, b.copy),
    choosers: join(a.choosers, b.choosers),
  };
}

function connected(surface: Surface): Surface {
  const live = (list: Element[]): Element[] => list.filter((el) => el.isConnected);
  return { controls: live(surface.controls), copy: live(surface.copy), choosers: live(surface.choosers) };
}

/**
 * Every node this crawl has already looked at, so what a press DISCLOSED is what
 * the DOM has never held rather than what it held a moment ago.
 *
 * Cumulative on purpose. A modal marks everything behind it `aria-hidden`, which
 * takes the dialog's own tab strip out of the surface and puts it back when the
 * modal closes — against a one-step diff those tab buttons read as a form that
 * had just been opened, and the crawl went on to press them.
 *
 * **It decides scope, and never coverage.** React can reuse a node and change
 * what it represents — an input rebound from one declaration to another when a
 * choice repaints the field — and a node already recorded here would carry the
 * new binding past a delta walk unseen. So the crawl walks the whole LIVE scope
 * after every press, and this only says what is newly in it.
 */
class Seen {
  private readonly nodes = new Set<Element>();

  /** What is on screen now and was never on screen before; records all of it. */
  takeNew(surface: Surface): Surface {
    const fresh = (list: Element[]): Element[] => list.filter((el) => !this.nodes.has(el));
    const taken: Surface = {
      controls: fresh(surface.controls),
      copy: fresh(surface.copy),
      choosers: fresh(surface.choosers),
    };
    for (const list of [surface.controls, surface.copy, surface.choosers]) {
      for (const el of list) this.nodes.add(el);
    }
    return taken;
  }
}

interface WalkResult {
  /** Controls that are neither a declaration binding nor a reasoned exclusion. */
  readonly unaccounted: string[];
  /** Rendered copy that is not the declaration's own words. */
  readonly drift: string[];
  /** Declarations this pane actually rendered a control for. */
  readonly bound: Set<string>;
  /**
   * The subset of {@link bound} whose control HOLDS the value — an input, a
   * switch, a toggle card. A collection's operations are buttons, so a
   * declaration bound only by a button may have no editable control rendered at
   * all: `network.egress.hosts[].host` is bound by the row's *Edit* button
   * whether or not pressing it opens anything.
   */
  readonly valueBound: Set<string>;
  /** Declarations whose label AND description this pane rendered. */
  readonly explained: Set<string>;
}

function walk(pane: ParentNode, tab: SettingTab): WalkResult {
  return walkSurface(surfaceOf(pane), tab);
}

function walkSurface(surface: Surface, tab: SettingTab): WalkResult {
  const exclusions = SETTING_EXCLUSIONS.filter((x) => x.tab === tab);
  const wholeTab = exclusions.some((x) => x.wholeTab);
  const excused = new Set(exclusions.flatMap(namesOf));
  const inExcusedRegion = excusedRegionOf(tab);
  const unaccounted: string[] = [];
  const bound = new Set<string>();
  const valueBound = new Set<string>();

  for (const el of surface.controls) {
    if (inExcusedRegion(el)) continue;
    const key = el.getAttribute("data-setting");
    if (key) {
      const declaration = findSetting(key);
      if (!declaration) {
        unaccounted.push(`${describeControl(el)} binds undeclared "${key}"`);
      } else if (declaration.tab !== tab) {
        /*
          A binding is an attribute, so accepting ANY existing declaration let a
          control claim one that has nothing to do with it — a new field in the
          role editor bound to `advanced.liveSteering` passed here, and the
          agent then read that setting's description for a control that saves
          something else. A declaration names the tab it belongs to, so a
          control on a different one is naming a declaration that is not its.
        */
        unaccounted.push(
          `${describeControl(el)} binds "${key}", which is declared for the `
          + `${declaration.tab} tab and not this one`,
        );
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
        if (editsAValue(el)) valueBound.add(key);
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
    for (const el of surface.copy.filter((node) => node.hasAttribute(attribute))) {
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

  return { unaccounted, drift, bound, valueBound, explained };
}

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
  agentSystemInstructions: "You are working inside ShipIt.",
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
/**
 * The tabs to walk, taken from the dialog itself rather than listed here: a tab
 * added to `Settings.tsx` and forgotten here would be a pane nothing ever looks
 * at, and the test would go on passing.
 */
const GLOBAL_TABS: SettingTab[] = SETTINGS_TABS.filter((tab) => tab !== "skills");

type ProjectTab = (typeof PROJECT_SETTINGS_TABS)[number];

/** The Project Settings tab names, as the catalogue spells them. */
const PROJECT_TAB_OF: Record<ProjectTab, SettingTab> = {
  secrets: "project-secrets",
  deployments: "project-deployments",
  appearance: "project-appearance",
};

const PROJECT_TABS = PROJECT_SETTINGS_TABS.map(
  (initial) => ({ initial, tab: PROJECT_TAB_OF[initial] }),
);

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

/** Which tab the dialog has selected, so a link that moves it can be told apart. */
function selectedTab(): string | null {
  return document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("id") ?? null;
}

/**
 * A control that might DISCLOSE more controls: a button that runs something, or
 * a choice that repaints the fields around it. A switch and a toggle card are
 * not — they carry their own value, and the walk already accounts for them.
 */
function isDisclosureTrigger(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return true;
  return tag === "button" && !el.hasAttribute("aria-checked");
}

function isChooser(el: Element): boolean {
  return el.getAttribute("role") === "menuitem";
}

/**
 * Stable enough to press a control once across re-renders, and distinct enough
 * to tell two controls apart.
 *
 * Node identity would be exact and is wrong: React replaces nodes, so the same
 * button would be pressed forever. Tag, test id and accessible name alone are
 * wrong the other way — two rows each carrying an unnamed *Open* collide, and
 * the second form is never opened.
 *
 * So the nearest ANCESTOR carrying a test id joins in, **and its position among
 * the ancestors sharing that test id**, because a list gives every row the same
 * one (`ssh-host-row`, `credential-row`). Both survive a re-render of the row's
 * contents, which is what identity by node does not.
 */
function triggerId(el: Element): string {
  const owner = el.parentElement?.closest("[data-testid]");
  const testId = owner?.getAttribute("data-testid") ?? "";
  const among = testId
    ? [...el.ownerDocument.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`)].indexOf(owner!)
    : -1;
  return `${testId}#${among}|${el.tagName}|${el.getAttribute("data-testid") ?? ""}|${accessibleName(el)}`;
}

/**
 * One thing that can be done to a control, and doing it. A button has one; a
 * choice has one per option, **separately**, because the fields an option
 * repaints are gone by the time the next one is picked — the MCP transport
 * selector renders a command or a URL and never both.
 */
interface Press {
  readonly id: string;
  readonly run: () => Promise<void>;
}

function pressesFor(el: Element): Press[] {
  if (el.tagName.toLowerCase() !== "select") {
    return [{ id: triggerId(el), run: () => userEvent.click(el) }];
  }
  const select = el as HTMLSelectElement;
  return [...select.options]
    .filter((option) => !option.disabled)
    .map((option) => ({
      id: `${triggerId(el)}|${option.value}`,
      run: async () => { await userEvent.selectOptions(select, option.value); },
    }));
}

/**
 * Nothing in the two dialogs takes anywhere near this many presses; it exists so
 * a control that re-renders under a new accessible name on every press cannot
 * spin forever. **Reaching it fails the test**, because a crawl that stopped
 * early is coverage it did not do.
 */
const PRESS_CAP = 200;

/**
 * **Every form the pane can open, not only the ones it renders at rest**
 * (docs/299-agent-settings-access req 5 and req 7).
 *
 * **The set of forms is not enumerated**, because a list of forms is a list
 * somebody maintains: the SSH add-a-destination form was never on it, so its four
 * boxes were controls no test could fail on and three wrote undeclared stored
 * values. Every trigger in scope is pressed once instead, and whatever appears in
 * the DOCUMENT as a result — inside the pane or in a portal beside it — is walked
 * under the same rules. The scope grows as it goes, so a form inside a form is
 * reached with nothing naming either.
 *
 * Three bounds are real and are stated rather than hidden:
 *
 *  - **Scope is the pane and what it disclosed**, never the whole document, so
 *    the dialog's own furniture is out. Pressing Close would end the crawl with
 *    an empty document and nothing to report, which is the silent skip this
 *    replaces.
 *  - **A press that moves the dialog to another TAB is navigation, not
 *    disclosure.** The Voice tab links to Keyboard; without this the whole of
 *    another tab would arrive as one delta. The tab is re-rendered and the crawl
 *    goes on, with that trigger counted as pressed.
 *  - **A disclosure behind something other than a press or a choice is not
 *    reached** — typing into a box, a drag, a hover. Nothing in either dialog
 *    works that way today; a control that starts to would need this to grow.
 *
 * It presses *Reset Everything* and *Remove* alike, and that is safe rather than
 * lucky: every write in both dialogs goes out through `fetch`, which the fixture
 * stubs to reject, so a press can change a component's own state and nothing
 * else. A control that starts writing through something else would break that.
 */
async function crawl(
  render: () => Promise<HTMLElement>,
  tab: SettingTab,
): Promise<WalkResult[]> {
  let pane = await render();
  let seen = new Seen();
  /**
   * What each press opened, newest group first. Depth-first, and in document
   * order inside a group: a form's own Cancel is the last control in it, so the
   * fields are pressed before the button that closes them — and a menu left open
   * while the crawl went back to the pane would be closed by the next press
   * there, stranding every operation it offered.
   */
  let disclosed: Element[][] = [];
  /** Everything ever disclosed, for the live-scope walk after each press. */
  let opened: Surface = EMPTY_SURFACE;
  const pressed = new Set<string>();
  const results: WalkResult[] = [walk(pane, tab)];
  seen.takeNew(surfaceOf(document.body));

  /**
   * The pane as it is NOW, plus every still-attached node the crawl opened.
   *
   * Walked after every press rather than only the delta: React reuses nodes, so
   * a box rebound from one declaration to another — or a description whose
   * element stays and whose text changes — is a node the delta has already seen
   * and would never look at again.
   */
  const liveScope = (): Surface => mergeSurfaces(surfaceOf(pane), connected(opened));

  const excused = excusedRegionOf(tab);
  const restart = async () => {
    cleanup();
    pane = await render();
    seen = new Seen();
    seen.takeNew(surfaceOf(document.body));
    disclosed = [];
    opened = EMPTY_SURFACE;
  };
  /** The press at which the tab was last started again, to tell a stall apart. */
  let restartedAt = -1;

  for (let n = 0; ; n++) {
    if (n === PRESS_CAP) {
      throw new Error(
        `The ${tab} tab is still disclosing controls after ${PRESS_CAP} presses. Either a control `
        + "re-renders under a new name every time it is pressed, or the tab has outgrown the cap; "
        + "stopping here quietly would be coverage this test did not do.",
      );
    }
    const pressable = (el: Element) =>
      el.isConnected && !excused(el) && (isDisclosureTrigger(el) || isChooser(el));
    const inScope = [
      ...disclosed.flat(),
      ...controlsIn(pane),
      ...choosersIn(pane),
    ].filter(pressable);
    const next = inScope.flatMap(pressesFor).find((press) => !pressed.has(press.id));
    if (!next) {
      /*
        Nothing left to press — or nothing REACHABLE. A modal takes the pane out
        of the surface (`aria-hidden`) while it is open, and the one control that
        would close an excused region is itself inside that region, so the crawl
        would stop there with most of the tab unpressed. Starting the tab again
        clears whatever is open; `pressed` carries over, so it resumes rather
        than repeats, and a restart that finds nothing new ends the crawl.
      */
      if (restartedAt === n - 1) break;
      restartedAt = n;
      await restart();
      continue;
    }
    pressed.add(next.id);

    const tabBefore = selectedTab();
    await next.run();
    if (selectedTab() !== tabBefore) {
      await restart();
      continue;
    }

    const fresh = seen.takeNew(surfaceOf(document.body));
    if (fresh.controls.length + fresh.choosers.length > 0) {
      const group = [...fresh.controls, ...fresh.choosers].sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      disclosed = [group, ...disclosed];
    }
    opened = mergeSurfaces(connected(opened), fresh);
    results.push(walkSurface(liveScope(), tab));
  }
  return results;
}

async function renderGlobalTab(tab: SettingTab): Promise<HTMLElement> {
  act(() => { useUiStore.getState().setSettingsTab(tab as never); });
  render(<Settings {...settingsProps} />);
  await settle();
  return activePane();
}

async function renderProjectTab(initial: ProjectTab): Promise<HTMLElement> {
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

/**
 * A pane the crawl can be pointed at, for a shape no panel has today. Plain DOM
 * on purpose: what is under test is the crawl, not a component.
 */
function paneFixture(html: string): HTMLElement {
  const pane = document.createElement("div");
  pane.innerHTML = html;
  document.body.append(pane);
  return pane;
}

/** The keys a crawl found bound to nothing declared, in the order it saw them. */
function undeclaredBindings(results: WalkResult[]): string[] {
  return collect(results, "unaccounted")
    .map((complaint) => /binds undeclared "([^"]+)"/.exec(complaint)?.[1])
    .filter((key) => key !== undefined);
}

async function crawlGlobalTab(tab: SettingTab): Promise<WalkResult[]> {
  return crawl(() => renderGlobalTab(tab), tab);
}

async function crawlProjectTab(initial: ProjectTab, tab: SettingTab): Promise<WalkResult[]> {
  return crawl(() => renderProjectTab(initial), tab);
}

/**
 * One entry per distinct complaint. The crawl walks the whole live scope after
 * every press, so an unaccounted control that stays on screen is reported once
 * for each press that followed it.
 */
function collect(results: WalkResult[], field: "unaccounted" | "drift"): string[] {
  return [...new Set(results.flatMap((result) => result[field]))];
}

describe("every control in the Settings dialog is declared or excused", () => {
  for (const tab of GLOBAL_TABS) {
    it(`accounts for the ${tab} tab, and for every form it opens`, async () => {
      expect(collect(await crawlGlobalTab(tab), "unaccounted")).toEqual([]);
    });
  }

  it("leaves out only a tab the catalogue exempts whole", () => {
    const walked = new Set<string>(GLOBAL_TABS);
    const exempt = SETTING_EXCLUSIONS.filter((x) => x.wholeTab).map((x) => x.tab);
    // Both lists come from the dialogs themselves, so a tab added to either one
    // is walked unless `exclusions.ts` says in prose why it holds no setting.
    expect(SETTINGS_TABS.filter((tab: string) => !walked.has(tab))).toEqual(exempt);
    expect(PROJECT_SETTINGS_TABS.map((tab) => PROJECT_TAB_OF[tab])).toEqual(
      PROJECT_TABS.map((entry) => entry.tab),
    );
  });

  /*
    The binding is an attribute and nothing else, so before this the walk asked
    only whether the named declaration EXISTS. A new field in the role editor
    could name `advanced.liveSteering`, pass every test, and reach the agent
    carrying a description for a different setting entirely — the control was
    bound, so it never showed up as unaccounted.

    A declaration names its own tab, which is what makes the mismatch decidable
    from the DOM. What stays undecidable is a role-editor box bound to a
    DIFFERENT ROLE FIELD's declaration; `ROLE_FIELD_SETTINGS`
    (`settings-catalogue/roles-settings.ts`) is the other direction, over the
    stored type, and the two together are as far as this can be taken.
  */
  it("catches a control that binds a declaration belonging to another tab", () => {
    const pane = document.createElement("div");
    pane.innerHTML =
      '<input data-setting="advanced.liveSteering" aria-label="Standing instructions" />';
    expect(walk(pane, "roles").unaccounted).toEqual([
      expect.stringContaining("declared for the advanced tab"),
    ]);
  });

  /*
    Two shapes the crawl has to survive, which no panel in the dialogs happens to
    have today — so they are put to it directly rather than waited for. Both were
    real holes when this was written: the first passed because the crawl walked
    only what a press had just ADDED, and the second because two controls with
    one name were one control to it.
  */
  it("looks again at a node whose binding a press changed", async () => {
    const pane = paneFixture(`
      <input data-setting="advanced.liveSteering" aria-label="Live steering" id="box" />
      <button id="flip">Flip</button>
    `);
    pane.querySelector("#flip")!.addEventListener("click", () => {
      pane.querySelector("#box")!.setAttribute("data-setting", "advanced.notASetting");
    });

    // The plain buttons are unaccounted too — nothing excuses "Flip" — so this
    // asks only about the binding the crawl had to look twice to see.
    expect(undeclaredBindings(await crawl(async () => pane, "advanced")))
      .toEqual(['advanced.notASetting']);
  });

  it("presses two controls that share a name in rows that share a test id", async () => {
    const pane = paneFixture(
      ["first", "second"].map((row) => `
        <div data-testid="row">
          <button data-open="${row}">Open</button>
          <span data-form="${row}"></span>
        </div>
      `).join(""),
    );
    for (const button of pane.querySelectorAll("[data-open]")) {
      button.addEventListener("click", () => {
        const row = button.getAttribute("data-open");
        pane.querySelector(`[data-form="${row}"]`)!.innerHTML =
          `<input data-setting="advanced.${row}" aria-label="${row}" />`;
      });
    }

    expect(undeclaredBindings(await crawl(async () => pane, "advanced")))
      .toEqual(["advanced.first", "advanced.second"]);
  });

  /*
    The crawl is what reaches these, and each one was a hand-named opener until
    the third conformance review: the role editor, a credential row's overflow
    menu, the MCP form's two transports, an allowlist row mid-edit. They are
    listed here as the surfaces that must still be REACHED, not as the way to
    reach them — the vacuity test below fails if any of their fields stops being
    bound, whatever opens it.
  */
  it("reaches the forms that only exist once something is pressed", async () => {
    /*
      `valueBound`, never `bound`: every one of these is a BOX inside a form, and
      a collection's operations are buttons that sit on the pane at rest. The
      allowlist's *Edit* button binds `network.egress.hosts[].host` whether or
      not pressing it opens anything, so asking only whether the key was bound
      would pass with the editor deleted.
    */
    const opensAField = async (tab: SettingTab, key: string) => {
      const results = await crawlGlobalTab(tab);
      cleanup();
      return results.some((result) => result.valueBound.has(key));
    };

    expect(await opensAField("roles", "roles[].prompt"), "the role editor").toBe(true);
    expect(await opensAField("services", "services.credentials[].label"), "a row rename").toBe(true);
    expect(await opensAField("services", "services.credentials[].secret"), "the add-a-provider wizard").toBe(true);
    expect(await opensAField("integrations", "mcp.servers[].url"), "the MCP http form").toBe(true);
    expect(await opensAField("integrations", "integrations.sshHosts[].address"), "the SSH form").toBe(true);
    expect(await opensAField("network", "network.egress.hosts[].host"), "an allowlist row").toBe(true);
  });
});

describe("every control in the Project Settings dialog is declared or excused", () => {
  for (const { tab, initial } of PROJECT_TABS) {
    it(`accounts for the ${initial} tab, and for every form it opens`, async () => {
      expect(collect(await crawlProjectTab(initial, tab), "unaccounted")).toEqual([]);
    });
  }
});

describe("the dialog's copy is the declaration's copy", () => {
  for (const tab of GLOBAL_TABS) {
    it(`writes none of its own on the ${tab} tab`, async () => {
      expect(collect(await crawlGlobalTab(tab), "drift")).toEqual([]);
    });
  }

  for (const { tab, initial } of PROJECT_TABS) {
    it(`writes none of its own on the project ${initial} tab`, async () => {
      expect(collect(await crawlProjectTab(initial, tab), "drift")).toEqual([]);
    });
  }
});

/**
 * Declarations whose control this walk cannot reach, each with the reason. A
 * declaration missing from the walk AND from here fails the test below, so a
 * control that quietly stops being rendered cannot pass as coverage.
 */
const UNREACHED: Record<string, string> = {
  /*
    Empty, which is the strongest state it can be in — and it was not empty
    before the crawl. `services.providerAccounts[].connection` lived here, on
    the reasoning that its control is the sign-in inside the add-a-provider
    wizard and "the wizard is a flow rather than a pane". The crawl walks into
    the wizard like anything else, so the entry was a statement about the walk's
    old boundary rather than about the control.

    It stays because a genuine one would otherwise have nowhere to be named, and
    an unnamed unreachable declaration is the silent skip this file exists to
    prevent.
  */
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
  "advanced.sessionStatusCard",
  "advanced.soundOnFinish",
  "instructions.agentInstructionsEnabled",
  "instructions.opsInstructions",
  "instructions.userInstructions",
  "integrations.autoCreatePr",
  // The add-a-destination form's four boxes. They carried a placeholder and an
  // `aria-label` of their own until this slice, and three of them wrote stored
  // values no declaration described at all.
  "integrations.sshHosts[].address",
  "integrations.sshHosts[].label",
  "integrations.sshHosts[].port",
  "integrations.sshHosts[].user",
  // The MCP form's boxes. They rendered the declared LABEL and no description
  // until docs/299 — while the labels carried hand-written suffixes of their
  // own ("(space-separated)") that the declaration is supposed to hold. Those
  // sentences moved into the declarations and the form renders them, so the
  // drift check above now compares the MCP copy against the catalogue too.
  "mcp.servers[].args",
  "mcp.servers[].command",
  "mcp.servers[].name",
  "mcp.servers[].npmPackage",
  "mcp.servers[].url",
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
      record(...await crawlGlobalTab(tab));
      cleanup();
    }
    for (const { tab, initial } of PROJECT_TABS) {
      record(...await crawlProjectTab(initial, tab));
      cleanup();
    }

    const missing = ALL_SETTINGS.map((d) => d.key).filter((key) => !seen.has(key));
    expect(missing.sort()).toEqual(Object.keys(UNREACHED).sort());
    expect([...explained].sort()).toEqual([...EXPLAINED_IN_THE_DIALOG].sort());
  });
});
