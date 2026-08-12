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
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
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
function renderRows(provider: "claude" | "codex" = "claude") {
  return render(
    <ProviderAccountRows provider={provider} agent={provider === "claude" ? agent : undefined} />,
  );
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
    installFailingFetch("that session is running");
    renderRows();

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
    renderRows();

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
    renderRows();
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
    renderRows("codex");
    act(() => {
      useSettingsStore.getState().setProviderAccountNotice("claude", { kind: "error", message: "Claude's problem" });
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
  it("names the service in the empty state, not the harness", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    renderRows();
    expect(screen.getByTestId("provider-accounts-empty-claude")).toHaveTextContent(
      /No Anthropic subscription connected/,
    );
    // req 17 — it points at the one way in, which is not on this card.
    expect(screen.getByTestId("provider-accounts-empty-claude")).toHaveTextContent(/Add a service/);
    expect(screen.queryByText(/Claude subscription connected/)).toBeNull();
  });

  it("says which harness is missing when its CLI is not installed", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    render(
      <ProviderAccountRows
        provider="claude"
        agent={{ ...agent, installed: false }}
      />,
    );
    expect(screen.getByTestId("provider-not-installed-claude")).toHaveTextContent(
      /Claude CLI is not installed/,
    );
  });
});

/**
 * docs/150 req 19 — the provider-wide purge, which a row's Disconnect is NOT.
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
