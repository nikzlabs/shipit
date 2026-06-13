/**
 * Component tests for SettingsIntegrations (docs/201).
 *
 * The Integrations tab tiers three previously-separate surfaces into one:
 * curated "Connected services" (GitHub, Linear) over "MCP servers". These
 * assertions pin the tiering, the "Managed by ShipIt" badge that signals the
 * credential-brokering difference, and that the GitHub connection + PR toggle
 * moved here intact.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SettingsIntegrations } from "./SettingsIntegrations.js";
import { useMcpStore } from "../stores/mcp-store.js";

const originalFetch = globalThis.fetch;

/** Permissive GET stub — the embedded MCP/tracker panels fetch their state on
 * mount; every route resolves to an empty-but-ok payload. */
function installFetchStub() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;
    const body =
      url.includes("/api/mcp-servers") ? { servers: [] }
      : url.includes("/api/mcp-oauth") ? { providers: [] }
      : url.includes("/api/trackers") ? { trackers: [] }
      : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
}

const baseProps = {
  onGitHubLogout: vi.fn(),
  onGitHubTokenSubmit: vi.fn(),
  hasActiveSession: false,
};

describe("SettingsIntegrations (docs/201)", () => {
  beforeEach(() => {
    useMcpStore.getState().reset();
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("renders both tiers: Connected services over MCP servers", async () => {
    render(<SettingsIntegrations {...baseProps} githubStatus={{ authenticated: false }} />);
    expect(screen.getByText("Connected services")).toBeInTheDocument();
    expect(screen.getByText("MCP servers")).toBeInTheDocument();
    // Linear lives in the curated tier, next to GitHub — not as an MCP.
    await waitFor(() => expect(screen.getByText("Linear")).toBeInTheDocument());
  });

  it("badges curated services as Managed by ShipIt", () => {
    render(
      <SettingsIntegrations
        {...baseProps}
        githubStatus={{ authenticated: true, username: "octocat" }}
      />,
    );
    // One badge for GitHub, one for Linear.
    expect(screen.getAllByText("Managed by ShipIt").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the GitHub token form when not authenticated", () => {
    render(<SettingsIntegrations {...baseProps} githubStatus={{ authenticated: false }} />);
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
  });

  it("shows the connected GitHub card + PR-automation toggle when authenticated", () => {
    render(
      <SettingsIntegrations
        {...baseProps}
        githubStatus={{ authenticated: true, username: "octocat" }}
      />,
    );
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByTestId("settings-disconnect")).toBeInTheDocument();
    expect(screen.getByTestId("settings-auto-create-pr")).toBeInTheDocument();
  });
});
