/**
 * docs/252 phase 2 — Settings → Services.
 *
 * The behaviours worth pinning are the ones that come from the requirements
 * rather than from the layout: the screen lists what you configured (not the
 * catalogue), the add-flow makes the billing mode an explicit choice (req 5),
 * and a key card carries no routing controls (req 12).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CredentialRoute } from "../../../server/shared/types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ServicesPanel } from "./ServicesPanel.js";

const route = (over: Partial<CredentialRoute> & Pick<CredentialRoute, "id" | "serviceId" | "billingMode" | "via">): CredentialRoute => ({
  label: over.id,
  isPrimary: false,
  priority: 0,
  status: "ready",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const claudeAgent = {
  id: "claude" as const,
  name: "Claude",
  installed: true,
  authConfigured: false,
  models: [],
  supportsReview: true,
};

const codexAgent = { ...claudeAgent, id: "codex" as const, name: "Codex" };

let fetchCalls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  fetchCalls = [];
  useSettingsStore.getState().setCredentialRoutes([]);
  useSettingsStore.getState().setProviderAccounts([]);
  useUiStore.getState().setToast(null);
  useUiStore.setState({ revealedServiceModes: [] });
  useSettingsStore.setState({ providerAccountNotices: {} });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ routes: [] }) });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ServicesPanel", () => {
  it("starts empty — the catalogue lives in the dialog, not on the screen", () => {
    render(<ServicesPanel />);
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
    // Nothing from the catalogue is listed until the user asks for it.
    expect(screen.queryByText("OpenRouter")).not.toBeInTheDocument();
  });

  it("renders one card per (service, billing mode), not one per credential", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
      route({ id: "cred_3", serviceId: "zai", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("service-card-zai:sub")).toBeInTheDocument();
    expect(screen.getByTestId("service-card-zai:key")).toBeInTheDocument();
    // Two credentials, one card.
    expect(screen.getByTestId("credential-row-cred_1")).toBeInTheDocument();
    expect(screen.getByTestId("credential-row-cred_2")).toBeInTheDocument();
  });

  it("offers 'Add another' only where a mode can hold several credentials (req 12)", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string" }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("service-add-credential-zai:sub")).toBeInTheDocument();
    // Keys never fail over, so a second one could never be reached.
    expect(screen.queryByTestId("service-add-credential-zai:key")).not.toBeInTheDocument();
  });

  it("walks service → billing mode → credential, and posts the triple", async () => {
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("services-add-empty"));

    await userEvent.click(screen.getByTestId("add-service-option-zai"));
    // GLM has both modes, so the mode step is a real choice (req 5).
    expect(screen.getByTestId("add-service-step-mode")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("add-service-mode-key"));

    await userEvent.type(screen.getByTestId("add-service-secret"), "sk-zai");
    await userEvent.click(screen.getByTestId("add-service-save"));

    await waitFor(() => {
      const post = fetchCalls.find((c) => c.url === "/api/credential-routes" && c.method === "POST");
      expect(post?.body).toEqual({ serviceId: "zai", billingMode: "key", secret: "sk-zai" });
    });
  });

  it("skips the mode step when a service has only one way in", async () => {
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-deepseek"));
    // A one-option choice is not a choice.
    expect(screen.queryByTestId("add-service-step-mode")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-service-step-credential")).toBeInTheDocument();
  });

  it("hands off to the accounts card for a mode connected only by signing in", async () => {
    // Not a dead end: an earlier cut told the user to press "Add account on its
    // card" while no card existed, because a card only appeared once an account
    // already did.
    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-account-only")).toBeInTheDocument();
    // OpenAI's subscription takes no supplied secret, so there is no input.
    expect(screen.queryByTestId("add-service-secret")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("add-service-continue"));
    // The card the message points at now exists, with its "Add account" button.
    expect(screen.getByTestId("provider-accounts-card-codex")).toBeInTheDocument();
    expect(screen.getByTestId("provider-account-add-codex")).toBeInTheDocument();
  });

  it("keeps the revealed card across a remount, so 'Add account' stays reachable", async () => {
    // Settings renders its tabs through Radix `TabsContent`, which UNMOUNTS the
    // inactive one. With the reveal held in this component's own state,
    // switching to another Settings tab and back dropped the card and left no
    // route to "Add account" but walking the whole add-flow again. Unmounting
    // and remounting is that tab switch, reduced to what actually breaks it.
    const { unmount } = render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await userEvent.click(screen.getByTestId("add-service-continue"));
    expect(screen.getByTestId("provider-account-add-codex")).toBeInTheDocument();

    unmount();
    render(<ServicesPanel agentList={[codexAgent]} />);
    expect(screen.getByTestId("provider-account-add-codex")).toBeInTheDocument();
  });

  it("offers BOTH a sign-in and a token for a mode that accepts both", async () => {
    // Anthropic's subscription takes an OAuth account and an env-supplied
    // token. Treating "takes an account" as "takes nothing else" would hide the
    // input; the reverse left signing in unreachable from this dialog.
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-secret")).toBeInTheDocument();
    expect(screen.getByTestId("add-service-continue")).toBeInTheDocument();
  });

  it("reorders a subscription's credentials, which changes which one is delivered", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-move-up-cred_2"));
    await waitFor(() => {
      const put = fetchCalls.find((c) => c.method === "PUT");
      expect(put?.url).toBe("/api/credential-routes/zai/sub/order");
      expect(put?.body).toEqual({ routeIds: ["cred_2", "cred_1"] });
    });
  });

  // docs/252 phase 5 — phase 2 stored this setting per `(service, mode)` with no
  // control able to reach it, and it did nothing until failover was real.
  it("offers the selection mode on a subscription holding several credentials", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-selection-mode-zai:sub-balanced"));
    await waitFor(() => {
      const put = fetchCalls.find((c) => c.url === "/api/settings");
      expect(put?.body).toEqual({ accountSelectionMode: { "zai:sub": "balanced" } });
    });
  });

  it("offers no selection mode on an API-key card, nor on a lone credential", () => {
    // req 12 rendered: keys do not fail over, so there is nothing to order and
    // nothing to spread — and with one credential there is nowhere to go.
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.queryByTestId("credential-selection-mode-deepseek:key")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credential-selection-mode-zai:sub")).not.toBeInTheDocument();
  });

  it("offers no ordering where a mode holds one credential", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.queryByTestId("credential-order-cred_1")).not.toBeInTheDocument();
  });

  it("removes a credential through the route endpoint", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-remove-cred_1"));
    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: "/api/credential-routes/cred_1",
        method: "DELETE",
        body: undefined,
      });
    });
  });

  it("replaces a secret without changing the route", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-replace-cred_1"));
    await userEvent.type(screen.getByTestId("credential-replace-input-cred_1"), "sk-new");
    await userEvent.click(screen.getByTestId("credential-replace-submit-cred_1"));
    await waitFor(() => {
      const patch = fetchCalls.find((c) => c.method === "PATCH");
      expect(patch?.url).toBe("/api/credential-routes/cred_1");
      expect(patch?.body).toEqual({ secret: "sk-new" });
    });
  });

  it("renders an account-backed subscription through the accounts card, with no key disclosure", () => {
    const now = Date.now();
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);
    expect(screen.getByTestId("provider-accounts-card-claude")).toBeInTheDocument();
    // The Anthropic key is its own `(anthropic, key)` card here, so the
    // accounts card must not offer a second editor for it.
    expect(screen.queryByTestId("provider-toggle-api-key-claude")).not.toBeInTheDocument();
  });
});

/**
 * docs/257 req 5 — a credential row reports its own failures, inline.
 *
 * Reachable during onboarding and not only after it: between docs/252 phases 2
 * and 3 a user can add a DeepSeek key from the onboarding panel and get a card
 * whose `canRunTurns` stays false, so these rows exist while the panel is still
 * on screen and a toast fired from inside it would land somewhere else.
 */
describe("ServicesPanel credential-row errors (docs/257 req 5)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "nope" }),
      }),
    );
  });

  it("reports a failed removal on the row, not as a toast", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-remove-cred_1"));
    await waitFor(() => {
      expect(screen.getByTestId("credential-error-cred_1")).toBeInTheDocument();
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("reports a failed replacement on the row", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-replace-cred_1"));
    await userEvent.type(screen.getByTestId("credential-replace-input-cred_1"), "sk-new");
    await userEvent.click(screen.getByTestId("credential-replace-submit-cred_1"));
    await waitFor(() => {
      expect(screen.getByTestId("credential-error-cred_1")).toBeInTheDocument();
    });
    expect(useUiStore.getState().toast).toBeNull();
  });
});

/**
 * docs/257 req 5 — the case the card's own tests cannot see.
 *
 * `ProviderAccountsCard` renders in isolation in its own suite, so a notice set
 * as the last account disappears looks fine there. In this HOST it is not: the
 * card's presence is derived from the account list, so the notice was mounted
 * and unmounted in the same commit and the user never learned which sessions
 * the disconnect had stranded. Found by cross-backend review.
 */
describe("ServicesPanel keeps a card that has something to say (docs/257 req 5)", () => {
  it("still shows the disconnect result after the LAST account is removed", async () => {
    const now = Date.now();
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    // The server disconnects and reports what it stranded (docs/150 req 23).
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ accounts: [], switchedSessionIds: [], strandedSessionIds: ["s1", "s2"] }),
      }),
    );

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(
      within(screen.getByTestId("provider-account-row-acct_1")).getByRole("button", { name: "Disconnect" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("provider-accounts-notice-claude"))
        .toHaveTextContent("2 session(s) have no connected Claude account");
    });
    // The row really is gone — this is not the notice surviving because nothing
    // was removed.
    expect(screen.queryByTestId("provider-account-row-acct_1")).toBeNull();
  });

  it("drops the card again once the notice is dismissed", async () => {
    useSettingsStore.getState().setProviderAccounts([]);
    useSettingsStore.getState().setProviderAccountNotice("claude", { kind: "info", message: "Disconnected." });
    render(<ServicesPanel agentList={[claudeAgent]} />);
    expect(screen.getByTestId("provider-accounts-card-claude")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("provider-accounts-notice-claude-dismiss"));
    // Back to "only what you configured" — the card was on screen to deliver a
    // message, not because anything is configured.
    expect(screen.queryByTestId("provider-accounts-card-claude")).toBeNull();
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
  });
});
