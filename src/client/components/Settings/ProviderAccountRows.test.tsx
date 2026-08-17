/**
 * docs/257 req 5 — results and errors render next to the step that produced
 * them, not as a toast somewhere else on screen.
 *
 * Every case here asserts the absence of a toast as well as the presence of the
 * inline notice — "we also render it inline" would pass a presence-only test.
 *
 * The failover-cutoff tests that used to live beside these moved to
 * `CredentialRouting.test.tsx` with the control itself (docs/252).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderAccountRows } from "./ProviderAccountRows.js";
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

/**
 * The body as `ServiceCard` hosts it. There is no longer an "Add account"
 * button to render beside it: docs/252 req 17 moved adding into the
 * add-service dialog, so a failure while *creating* an account is that
 * dialog's to report (`ServicesPanel.test.tsx`), and what is left here is
 * everything done to an account that already exists.
 */
function renderRows(provider: "claude" | "codex" = "claude", onReconnect = vi.fn()) {
  const result = render(
    <ProviderAccountRows
      provider={provider}
      agent={provider === "claude" ? agent : undefined}
      billingMode="sub"
      onReconnect={onReconnect}
    />,
  );
  return { ...result, onReconnect };
}

/**
 * Open one row's `⋯`. docs/252 req 19 moved every per-account verb in there, so
 * a test that used to find "Disconnect" as a permanently-rendered button now
 * has to open the menu first — which is the compaction, asserted.
 */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByLabelText(`Manage ${label}`));
}

/** Fail every request with a server-supplied message. */
function installFailingFetch(message: string) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 500 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useSettingsStore.getState().setProviderAccounts([account("a", true), account("b")]);
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.getState().setProviderAccounts([]);
  useSettingsStore.setState({ providerAccountNotices: {} });
});

describe("ProviderAccountRows inline results and errors (docs/257 req 5)", () => {
  it("reports a failed disconnect on the row it belongs to", async () => {
    const user = userEvent.setup();
    installFailingFetch("that session is running");
    renderRows();

    await openRowMenu(user, "a");
    await user.click(screen.getByTestId("provider-account-disconnect-a"));

    await waitFor(() => {
      expect(screen.getByTestId("provider-account-notice-a")).toHaveTextContent("that session is running");
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("disconnects in one click with no session bookkeeping to report (docs/260-turn-level-account-routing req 3)", async () => {
    // No pinning means no "moved N sessions" story: the row disappears and the
    // remaining accounts render, nothing else. Sessions route among what
    // remains at their next turn.
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response(
        JSON.stringify({ accounts: [account("b", true)] }),
        { status: 200 },
      )),
    ));
    renderRows();

    await openRowMenu(user, "a");
    await user.click(screen.getByTestId("provider-account-disconnect-a"));

    await waitFor(() => {
      expect(screen.queryByTestId("provider-account-row-a")).toBeNull();
    });
    expect(screen.queryByTestId("provider-accounts-notice-claude")).toBeNull();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("gives the duplicate-account refusal a landing place on the card", () => {
    // The one credential failure that arrives from OUTSIDE the card: it comes
    // as an `agent_auth_failed` SSE, and the refusal deletes the row a per-row
    // error would have used (docs/150-multiple-provider-subscriptions req 22). It was a global toast.
    renderRows();
    act(() => {
      useSettingsStore.getState().setProviderAccountNotice("anthropic-oauth", {
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
    renderRows("codex");
    act(() => {
      useSettingsStore.getState().setProviderAccountNotice("anthropic-oauth", { kind: "error", message: "Claude's problem" });
    });
    expect(screen.queryByTestId("provider-accounts-notice-codex")).toBeNull();
  });
});

/**
 * docs/252 — the rows name the SERVICE, never the harness. "Claude
 * subscriptions" was the old heading, and it named the vendor of the CLI rather
 * than the vendor of the credential — the conflation this feature removes.
 */
describe("ProviderAccountRows naming", () => {
  /**
   * docs/252 req 19 — the empty-state box is **gone**, not reworded.
   *
   * It printed "No Anthropic subscription connected. Add one with Add a
   * service." above a *connected* credential of that same service, on every
   * card holding a supplied key and no account: its docstring assumed the only
   * way to reach it was a notice holding an empty card open, and that stopped
   * being true when the two delivery shapes became one card. A card that really
   * does reach zero credentials is removed by the panel, so the box was never
   * what kept it on screen.
   */
  it("says nothing at all with no accounts, rather than a box above the card's other credential", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    renderRows();
    expect(screen.queryByTestId("provider-accounts-empty-claude")).toBeNull();
    expect(screen.queryByText(/No Anthropic subscription connected/)).toBeNull();
  });

  it("says which harness is missing when its CLI is not installed", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    render(
      <ProviderAccountRows
        provider="claude"
        agent={{ ...agent, installed: false }}
        billingMode="sub"
        onReconnect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("provider-not-installed-claude")).toHaveTextContent(
      /Claude CLI is not installed/,
    );
  });
});

/**
 * docs/252 req 19 — **the row is `label · quota · ⋯`, and a healthy row says
 * nothing about its health.**
 */
describe("ProviderAccountRows compact row", () => {
  it("says nothing about a ready account beyond its name", () => {
    renderRows();
    const row = screen.getByTestId("provider-account-row-a");
    // No status pill, no "ready", no account UUID line, no permanently mounted
    // rename field, and no green dot: an earlier mock-up put a `StatusDot` on
    // every row, which is decoration on the normal case and a hue alone on the
    // abnormal one.
    expect(screen.queryByTestId("provider-account-row-a-status")).toBeNull();
    expect(row).not.toHaveTextContent(/ready/i);
    expect(row.querySelector("input")).toBeNull();
  });

  it("says in words what needs doing, in the colour that says it too", () => {
    useSettingsStore.getState().setProviderAccounts([{ ...account("a"), status: "auth_failed" }]);
    renderRows();
    const status = screen.getByTestId("provider-account-row-a-status");
    expect(status).toHaveTextContent("reconnect needed");
    expect(status.className).toContain("--color-error");
  });

  it("opens the rename field from the menu instead of holding one permanently", async () => {
    const user = userEvent.setup();
    renderRows();
    expect(screen.queryByTestId("provider-account-rename-input-a")).toBeNull();

    await openRowMenu(user, "a");
    await user.click(screen.getByTestId("provider-account-rename-a"));

    expect(screen.getByTestId("provider-account-rename-input-a")).toBeTruthy();
  });

  /**
   * The whole point of req 19's reconnect change: this component must NOT start
   * a login or render a challenge of its own. It did both, and
   * `AccountChallenge` returns `null` until the auth URL arrives, so the row
   * showed nothing between the click and the URL.
   */
  it("asks the panel to reconnect rather than posting a login itself", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { onReconnect } = renderRows();

    await openRowMenu(user, "a");
    await user.click(screen.getByTestId("provider-account-connect-a"));

    expect(onReconnect).toHaveBeenCalledWith("a");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * docs/252 req 21 — ordering is drag-and-drop, and *Make primary* is gone
   * with the carets. "Primary" was never a property: `isPrimary` is stamped on
   * read from position, and the endpoint behind that button was a reorder.
   */
  it("offers a drag grip and neither carets nor Make primary", async () => {
    const user = userEvent.setup();
    renderRows();
    expect(screen.getByTestId("provider-account-row-a-grip")).toBeTruthy();
    expect(screen.queryByTestId("provider-account-move-up-a")).toBeNull();
    expect(screen.queryByTestId("provider-account-move-down-a")).toBeNull();

    await openRowMenu(user, "a");
    expect(screen.queryByText("Make primary")).toBeNull();
    expect(screen.queryByText("Primary")).toBeNull();
  });

  it("offers no grip at all with one account, where there is no order to change", () => {
    useSettingsStore.getState().setProviderAccounts([account("a", true)]);
    renderRows();
    expect(screen.queryByTestId("provider-account-row-a-grip")).toBeNull();
  });
});

/**
 * docs/150-multiple-provider-subscriptions req 19 — the provider-wide purge, which a row's Disconnect is NOT.
 *
 * `DELETE /api/auth/api-key` clears every account's credentials *and* the
 * singleton pre-account path, where a legacy install's unscoped OAuth tokens
 * sit with no row to reach them from. It used to live on the Settings → Claude
 * tab and was nearly dropped with it; cross-backend review caught that.
 */
describe("ProviderAccountRows stale-credential escape hatch", () => {
  it("offers the provider-wide purge when rows exist and none can authenticate", async () => {
    useSettingsStore.getState().setProviderAccounts([
      { ...account("a", true), status: "auth_failed" },
      { ...account("b"), status: "unavailable" },
    ]);
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ accounts: [] }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderRows();

    fireEvent.click(screen.getByTestId("provider-clear-credentials-claude"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/api-key",
      expect.objectContaining({ method: "DELETE" }),
    ));
  });

  it("stays hidden while any account is usable", () => {
    // `account()` is `ready` by default — nothing here is stale.
    renderRows();
    expect(screen.queryByTestId("provider-stale-credentials-claude")).toBeNull();
  });

  it("stays hidden with no accounts at all, where there is nothing to describe", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    renderRows();
    expect(screen.queryByTestId("provider-stale-credentials-claude")).toBeNull();
  });
});
