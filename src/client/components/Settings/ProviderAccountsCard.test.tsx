/**
 * Component tests for ProviderAccountsCard's failover-cutoff inputs (docs/150
 * reqs 4-6).
 *
 * The bug these pin: the cutoff fields were uncontrolled with `onBlur` as the
 * only save trigger, so typing a number and closing Settings — or pressing
 * Enter — discarded the edit silently, and the field never re-synced when a
 * failed save rolled the store back.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { ProviderAccountsCard } from "./ProviderAccountsCard.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { CredentialRoute } from "../../../server/shared/types.js";

const agent: AgentOption = {
  id: "claude",
  name: "Claude",
  installed: true,
  hasRunnableModels: true,
  models: [],
  supportsReview: true,
};

function account(id: string, isPrimary = false): CredentialRoute {
  return {
    id,
    serviceId: "anthropic", billingMode: "sub", via: "account",
    label: id,
    isPrimary,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Records every PUT /api/settings body; resolves ok unless `fail` is set. */
function installFetch(options: { fail?: boolean } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.href,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify({}), { status: options.fail ? 500 : 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** The cutoff controls only render with two or more accounts (req 15). */
function renderCard() {
  return render(
    <ProviderAccountsCard provider="claude" agent={agent} onSubmitApiKey={() => {}} />,
  );
}

/**
 * docs/252 phase 2 — the routing settings for Claude's accounts live under
 * Anthropic's SUBSCRIPTION mode, not under the agent id.
 */
const CLAUDE_ROUTING_KEY = "anthropic:sub";

const settingsCalls = (calls: { url: string; method: string; body: unknown }[]) =>
  calls.filter((c) => c.url === "/api/settings" && c.method === "PUT");

beforeEach(() => {
  useSettingsStore.getState().setProviderAccounts([account("a", true), account("b")]);
  useSettingsStore.getState().setFailoverCutoffs(CLAUDE_ROUTING_KEY, { session: 90, weekly: 90 });
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.getState().setProviderAccounts([]);
  useSettingsStore.setState({ providerAccountNotices: {} });
});

describe("ProviderAccountsCard failover cutoffs", () => {
  it("saves a typed value on Enter, without any blur", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { session: 80 } },
    });
    expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 80, weekly: 90 });
  });

  it("saves a typed value on blur", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-weekly");
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { weekly: 75 } },
    });
  });

  it("saves a pending edit when the card unmounts without a blur", async () => {
    const calls = installFetch();
    const { unmount } = renderCard();

    fireEvent.change(screen.getByTestId("failover-cutoff-claude-session"), {
      target: { value: "60" },
    });
    expect(settingsCalls(calls)).toHaveLength(0);

    unmount();

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
    expect(settingsCalls(calls)[0]?.body).toEqual({
      failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { session: 60 } },
    });
  });

  it("commits both fields when the card unmounts with two pending edits", async () => {
    const calls = installFetch();
    const { unmount } = renderCard();

    fireEvent.change(screen.getByTestId("failover-cutoff-claude-session"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByTestId("failover-cutoff-claude-weekly"), {
      target: { value: "70" },
    });
    unmount();

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(2));
    expect(settingsCalls(calls).map((c) => c.body)).toEqual([
      { failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { session: 60 } } },
      { failoverCutoffs: { [CLAUDE_ROUTING_KEY]: { weekly: 70 } } },
    ]);
    expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 60, weekly: 70 });
  });

  it("does not double-submit when a blur follows Enter for the same edit", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => expect(settingsCalls(calls)).toHaveLength(1));
  });

  it("sends nothing for an out-of-range or empty value, on any commit path", async () => {
    const calls = installFetch();
    const { unmount } = renderCard();

    const session = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(session, { target: { value: "150" } });
    fireEvent.keyDown(session, { key: "Enter" });

    const weekly = screen.getByTestId("failover-cutoff-claude-weekly");
    fireEvent.change(weekly, { target: { value: "" } });
    fireEvent.blur(weekly);

    fireEvent.change(session, { target: { value: "0" } });
    unmount();

    await Promise.resolve();
    expect(settingsCalls(calls)).toHaveLength(0);
    expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 90, weekly: 90 });
  });

  it("sends nothing when the value is retyped unchanged", async () => {
    const calls = installFetch();
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await Promise.resolve();
    expect(settingsCalls(calls)).toHaveLength(0);
  });

  it("rolls the displayed value back when the save fails", async () => {
    installFetch({ fail: true });
    renderCard();

    const input = screen.getByTestId("failover-cutoff-claude-session") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(useSettingsStore.getState().failoverCutoffs[CLAUDE_ROUTING_KEY]).toEqual({ session: 90, weekly: 90 }),
    );
    await waitFor(() => expect(input.value).toBe("90"));
    // docs/257 req 5 — the rollback reports itself on the card, not as a global
    // toast. The notice lives in the store precisely because this save can be
    // flushed from an unmount cleanup, after the component's state is gone.
    expect(screen.getByTestId("provider-accounts-notice-claude")).toHaveTextContent("failover cutoff");
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("hides the cutoff controls when only one account is connected", () => {
    useSettingsStore.getState().setProviderAccounts([account("a", true)]);
    renderCard();
    expect(screen.queryByTestId("failover-cutoffs-claude")).toBeNull();
  });
});

/**
 * docs/257 req 5 — results and errors render next to the step that produced
 * them, not as a toast somewhere else on screen.
 *
 * Moved in the shared component for BOTH hosts rather than branched on
 * onboarding: a second error-presentation path through the one component req 7
 * exists to keep single is precisely the drift req 7 forbids, and a toast is a
 * global side effect that cannot be scoped to its host anyway.
 *
 * Every case here asserts the absence of a toast as well as the presence of the
 * inline notice — "we also render it inline" would pass a presence-only test.
 */
describe("ProviderAccountsCard inline results and errors (docs/257 req 5)", () => {
  /** Fail every request with a server-supplied message. */
  function installFailingFetch(message: string) {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 500 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reports a failed 'Add account' on the card, because no row exists yet", async () => {
    installFailingFetch("GitHub says no");
    renderCard();

    fireEvent.click(screen.getByTestId("provider-account-add-claude"));

    await waitFor(() => {
      expect(screen.getByTestId("provider-accounts-notice-claude")).toHaveTextContent("GitHub says no");
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("reports a failed disconnect on the row it belongs to", async () => {
    installFailingFetch("that session is running");
    renderCard();

    // "Disconnect" is the third ghost button on each row.
    const row = screen.getByTestId("provider-account-row-a");
    fireEvent.click(within(row).getByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByTestId("provider-account-notice-a")).toHaveTextContent("that session is running");
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("disconnects in one click with no session bookkeeping to report (docs/260 req 3)", async () => {
    // No pinning means no "moved N sessions" story: the row disappears and the
    // remaining accounts render, nothing else. Sessions route among what
    // remains at their next turn.
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response(
        JSON.stringify({ accounts: [account("b", true)] }),
        { status: 200 },
      )),
    ));
    renderCard();

    const row = screen.getByTestId("provider-account-row-a");
    fireEvent.click(within(row).getByText("Disconnect"));

    await waitFor(() => {
      expect(screen.queryByTestId("provider-account-row-a")).toBeNull();
    });
    expect(screen.queryByTestId("provider-accounts-notice-claude")).toBeNull();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("gives the duplicate-account refusal a landing place on the card", () => {
    // The one credential failure that arrives from OUTSIDE the card: it comes
    // as an `agent_auth_failed` SSE, and the refusal deletes the row a per-row
    // error would have used (docs/150 req 22). It was a global toast.
    renderCard();
    act(() => {
      useSettingsStore.getState().setProviderAccountNotice("claude", {
        kind: "error",
        message: "That account is already connected.",
      });
    });

    const notice = screen.getByTestId("provider-accounts-notice-claude");
    expect(notice).toHaveTextContent("That account is already connected.");

    fireEvent.click(screen.getByTestId("provider-accounts-notice-claude-dismiss"));
    expect(screen.queryByTestId("provider-accounts-notice-claude")).toBeNull();
  });

  it("scopes an external notice to its own provider", () => {
    render(<ProviderAccountsCard provider="codex" agent={undefined} />);
    act(() => {
      useSettingsStore.getState().setProviderAccountNotice("claude", { kind: "error", message: "Claude's problem" });
    });
    expect(screen.queryByTestId("provider-accounts-notice-codex")).toBeNull();
  });
});
