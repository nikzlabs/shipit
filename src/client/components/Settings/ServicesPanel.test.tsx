/**
 * docs/252 phase 2 — Settings → Services.
 *
 * The behaviours worth pinning are the ones that come from the requirements
 * rather than from the layout: the screen lists what you configured (not the
 * catalogue), the add-flow makes the billing mode an explicit choice (req 5),
 * and a key card carries no routing controls (req 12).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CredentialRoute } from "../../../server/shared/types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
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

let fetchCalls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  fetchCalls = [];
  useSettingsStore.getState().setCredentialRoutes([]);
  useSettingsStore.getState().setProviderAccounts([]);
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

  it("says so, rather than offering a rejected input, when a mode takes a login", async () => {
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-account-only")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-secret")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-service-save")).toBeDisabled();
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
      { id: "acct_1", provider: "claude", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    render(<ServicesPanel agentList={[{ id: "claude", name: "Claude", installed: true, authConfigured: true, models: [], supportsReview: true }]} />);
    expect(screen.getByTestId("provider-accounts-card-claude")).toBeInTheDocument();
    // The Anthropic key is its own `(anthropic, key)` card here, so the
    // accounts card must not offer a second editor for it.
    expect(screen.queryByTestId("provider-toggle-api-key-claude")).not.toBeInTheDocument();
  });
});
