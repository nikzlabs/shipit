

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountChallenge, ProviderAccountRows } from "./ProviderAccountRows.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { CredentialRoute } from "../../../server/shared/types.js";
import type { LoginIntegrationId } from "../../../server/shared/catalogue/types.js";

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

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByLabelText(`Manage ${label}`));
}

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

describe("ProviderAccountRows compact row", () => {
  it("says nothing about a ready account beyond its name", () => {
    renderRows();
    const row = screen.getByTestId("provider-account-row-a");

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

    renderRows();
    expect(screen.queryByTestId("provider-stale-credentials-claude")).toBeNull();
  });

  it("stays hidden with no accounts at all, where there is nothing to describe", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    renderRows();
    expect(screen.queryByTestId("provider-stale-credentials-claude")).toBeNull();
  });
});

describe("a subscription with no quota reader (docs/274 req 16)", () => {
  function goAccount(overrides: Partial<CredentialRoute> = {}): CredentialRoute {
    return {
      id: "acct-go",
      serviceId: "opencode",
      billingMode: "sub",
      via: "account",
      label: "nik@go",
      isPrimary: true,
      status: "ready",
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }

  it("renders the row with no quota read-out", () => {
    useSettingsStore.getState().setProviderAccounts([goAccount()]);
    render(
      <ProviderAccountRows
        provider="opencode"
        agent={{ id: "opencode", name: "OpenCode", installed: true, hasRunnableModels: true, models: [], supportsReview: true }}
        billingMode="sub"
        onReconnect={vi.fn()}
      />,
    );
    const row = screen.getByTestId("provider-account-row-acct-go");
    expect(row).toHaveTextContent("nik@go");
    expect(row).not.toHaveTextContent(/5h/);
    expect(row).not.toHaveTextContent(/7d/);
    expect(row.querySelector("[data-meter-pct]")).toBeNull();
  });

  it("keeps the read-out on a subscription that does report one", () => {
    useSettingsStore.getState().setProviderAccounts([account("a", true)]);
    renderRows();

    const row = screen.getByTestId("provider-account-row-a");
    expect(row.querySelector("[data-meter-pct]")).not.toBeNull();
  });
});

describe("the authorization-code challenge", () => {
  const antigravityAccount: CredentialRoute = {
    id: "acct-agy",
    serviceId: "antigravity",
    billingMode: "sub",
    via: "account",
    label: "Antigravity account 1",
    isPrimary: true,
    status: "authenticating",
    createdAt: 0,
    updatedAt: 0,
  };

  function renderChallenge(provider: "antigravity" | "claude", loginId: LoginIntegrationId) {
    useSettingsStore.getState().setProviderAccountAuth(loginId, antigravityAccount.id, {
      loginId,
      accountId: antigravityAccount.id,
      verificationUri: "https://accounts.google.com/o/oauth2/auth?client_id=1234",
    });
    return render(
      <AccountChallenge
        provider={provider}
        account={{ ...antigravityAccount, serviceId: provider === "claude" ? "anthropic" : "antigravity" }}
        serviceName="Antigravity"
        onError={vi.fn()}
      />,
    );
  }

  /**
   * The POST only hands the code to the CLI, so it returns in milliseconds while
   * the sign-in runs on for seconds. With nothing left behind, a user who had
   * submitted could not tell that from a click that missed.
   */
  it("says the code went through, and keeps the button usable for a retry", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ success: true })))));
    renderChallenge("antigravity", "google-antigravity-oauth");

    await user.type(screen.getByPlaceholderText("Paste authorization code"), "4/0AY-code");
    await user.click(screen.getByRole("button", { name: "Submit code" }));

    await waitFor(() => expect(screen.getByTestId("provider-account-code-submitted-acct-agy"))
      .toBeInTheDocument());
    // A resolving event that never arrives — an SSE drop — must not leave the
    // panel inert: the dialog offers "Try again" only once no challenge pends.
    expect(screen.getByRole("button", { name: "Submit code" })).toBeEnabled();
  });

  it("does not claim a refused code went through", async () => {
    const user = userEvent.setup();
    installFailingFetch("Authorization code cannot be empty");
    renderChallenge("antigravity", "google-antigravity-oauth");

    await user.type(screen.getByPlaceholderText("Paste authorization code"), "4/0AY-code");
    await user.click(screen.getByRole("button", { name: "Submit code" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Submit code" })).toBeEnabled());
    expect(screen.queryByTestId("provider-account-code-submitted-acct-agy")).not.toBeInTheDocument();
  });

  // A second attempt reuses this component, so a confirmation that outlived its
  // own challenge would tell the user the new link's code had been sent.
  it("retires the confirmation when a new link replaces the one it answered", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ success: true })))));
    renderChallenge("antigravity", "google-antigravity-oauth");

    await user.type(screen.getByPlaceholderText("Paste authorization code"), "4/0AY-code");
    await user.click(screen.getByRole("button", { name: "Submit code" }));
    await waitFor(() => expect(screen.getByTestId("provider-account-code-submitted-acct-agy"))
      .toBeInTheDocument());

    act(() => {
      useSettingsStore.getState().setProviderAccountAuth("google-antigravity-oauth", "acct-agy", {
        loginId: "google-antigravity-oauth",
        accountId: "acct-agy",
        verificationUri: "https://accounts.google.com/o/oauth2/auth?client_id=5678",
      });
    });

    await waitFor(() => expect(screen.queryByTestId("provider-account-code-submitted-acct-agy"))
      .not.toBeInTheDocument());
  });

  // The CLI gives up 60 s after printing the link, which covers the whole Google
  // consent round trip — a user who learns that from the failure has lost the try.
  it("states Antigravity's window before the attempt, and invents none for Claude", () => {
    renderChallenge("antigravity", "google-antigravity-oauth");
    expect(screen.getByTestId("provider-account-challenge-acct-agy"))
      .toHaveTextContent("expires about 60 seconds");
    cleanup();

    renderChallenge("claude", "anthropic-oauth");
    expect(screen.getByTestId("provider-account-challenge-acct-agy"))
      .not.toHaveTextContent("60 seconds");
  });
});
