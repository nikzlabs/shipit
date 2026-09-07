/**
 * docs/291-composer-before-claim reqs 1, 2 — **the settings controls work before
 * the session exists.**
 *
 * The reported failure: starting a session in a repository with no warm session
 * ready left the role control dead for the whole claim — a cold clone, so tens of
 * seconds — because the composer's `disabled` on `/{repo}/new` was literally "the
 * claim has not landed" and all four selectors read it.
 *
 * The distinction each test below pins is that `disabled` means two different
 * things depending on whether a session is bound. With one, a pick has to reach
 * that session's socket and a closed socket rightly bars it. Without one, the pick
 * is a seed applied from the connect URL, so it is delivered by being made.
 *
 * Rendered through `MessageInput` rather than the pickers directly, because the
 * condition under test (`settingsLocked`) is the composer's own and is the single
 * place both layouts read.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageInput } from "./MessageInput/MessageInput.js";
import { getSavedRoleName, saveRoleName } from "../utils/local-storage.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { AgentOption } from "../agent-types.js";
import type { RoleView } from "../../server/shared/types/agent-types.js";

const SESSION_ID = "session-1";

const DEEP_DIVE: RoleView = {
  name: "deep dive",
  params: {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  },
  reserved: false,
  resolved: {
    harnessId: "claude",
    harnessName: "Claude",
    serviceId: "anthropic",
    serviceName: "Anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    label: "Opus 5",
  },
};

const claude: AgentOption = {
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
  supportedPermissionModes: ["plan", "guarded", "auto"],
  reasoning: { label: "Reasoning", options: [{ value: "high", label: "High" }] },
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  localStorage.clear();
  useSettingsStore.setState({ roles: [DEEP_DIVE] } as never);
  useSessionStore.setState({ sessionId: null, sessions: [] } as never);
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ roles: [] } as never);
});

/**
 * `disabled` is what the new-session view passes while it waits, and `sessionId`
 * is the only thing that says whether a session is bound — on `/{repo}/new` before
 * the claim lands, `wsSessionId` is undefined.
 */
function renderComposer(props: { disabled: boolean; sessionId?: string; isLoading?: boolean }) {
  render(
    <MessageInput
      onSend={vi.fn()}
      disabled={props.disabled}
      isLoading={props.isLoading ?? false}
      agents={[claude]}
      activeAgentId="claude"
      onAgentChange={vi.fn()}
      onModelChange={vi.fn()}
      onReasoningChange={vi.fn()}
      onRoleChange={vi.fn()}
      {...(props.sessionId ? { sessionId: props.sessionId, hasActiveSession: true } : {})}
    />,
  );
}

describe("the composer's settings before a session exists", () => {
  it("offers the role while the claim is still running (req 1)", () => {
    renderComposer({ disabled: true });
    expect(screen.getByTestId("role-selector-trigger")).not.toBeDisabled();
  });

  it("offers the harness and model in the same window (req 2)", () => {
    // They are what "Adjust parameters…" opens, so they cannot be dead while the
    // role control above them is live.
    renderComposer({ disabled: true });
    expect(screen.getByTestId("harness-trigger")).not.toBeDisabled();
    expect(screen.getByTestId("model-trigger")).not.toBeDisabled();
  });

  it("still bars a pick a BOUND session's socket could not receive", () => {
    // The non-requirement: nothing changes for a composer with a session behind
    // it, where `disabled` carries `status !== "open"` and a pick would be lost.
    renderComposer({ disabled: true, sessionId: SESSION_ID });
    expect(screen.getByTestId("role-selector-trigger")).toBeDisabled();
  });

  it("still bars a pick while a turn is running, session or not", () => {
    // `isLoading` is unconditional: a running turn pins the parameters whether or
    // not a socket is involved.
    renderComposer({ disabled: false, isLoading: true });
    expect(screen.getByTestId("role-selector-trigger")).toBeDisabled();
  });
});

/**
 * docs/291-composer-before-claim req 4 — **what the session starts on is what the
 * composer was showing.**
 *
 * The controls being live is only half of it. Before this feature the four
 * selectors were dead during the claim, so leaving a role by adjusting one of its
 * parameters could not happen there; now it can, and the seed that survives the
 * claim has to agree with the row. `useSessionWebSocket` puts `saveRoleName`'s
 * slot in the connect URL and the server applies `role=` LAST, over the harness,
 * model and reasoning seeds — so a stale role seed silently overrules the pick the
 * user is looking at.
 */
describe("leaving a role with no session bound", () => {
  it("clears the saved role, not just the displayed one", async () => {
    const user = userEvent.setup();
    saveRoleName("deep dive");
    renderComposer({ disabled: true });
    expect(screen.getByTestId("role-selector-trigger")).toHaveTextContent("deep dive");

    // Adjust one of the three the role set — the parameters it replaced.
    await user.click(screen.getByTestId("role-selector-trigger"));
    await user.click(await screen.findByTestId("role-adjust-parameters"));
    await user.click(screen.getByTestId("model-trigger"));
    await user.click(await screen.findByTestId("model-option-claude-opus-5"));

    expect(getSavedRoleName()).toBeUndefined();
  });

  it("leaves a BOUND session's saved role to the server's answer", () => {
    // There the server decides whether a parameter actually moved, and
    // re-selecting the value a role already set is not a change (docs/272 req 15).
    saveRoleName("deep dive");
    renderComposer({ disabled: false, sessionId: SESSION_ID });
    expect(getSavedRoleName()).toBe("deep dive");
  });
});
