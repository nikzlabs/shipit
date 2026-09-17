/**
 * The Integrations tab's shape (docs/201), now that its first tier is generated
 * from the declarations (docs/308-data-driven-settings slice 5).
 *
 * What is asserted here is the TAB: which sections it has, in what order, and
 * that the two hand-written panels still sit below the generated block. What
 * each connection does lives beside its component.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SettingsIntegrations } from "./SettingsIntegrations.js";
import { useMcpStore } from "../stores/mcp-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { GLOBAL_SETTINGS } from "../../server/shared/settings-catalogue/index.js";

const originalFetch = globalThis.fetch;

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

describe("SettingsIntegrations (docs/201)", () => {
  beforeEach(() => {
    useMcpStore.getState().reset();
    useSettingsStore.getState().setGithubStatus({ authenticated: false });
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("renders the tiers in order: the generated rows, then SSH hosts, then MCP", async () => {
    const { container } = render(<SettingsIntegrations hasActiveSession={false} />);

    const headings = [...container.querySelectorAll("h3")]
      .map((h) => h.textContent)
      .filter((text): text is string => Boolean(text));
    // The generated sections lead, in declaration order, and the two panels
    // slice 6 has yet to register follow them where this file places them.
    expect(headings).toEqual([
      "Pull requests", "Connected services", "GitHub", "Linear", "SSH hosts", "MCP servers",
    ]);

    await waitFor(() => expect(screen.getByTestId("settings-trackers")).toBeInTheDocument());
    expect(screen.getByTestId("settings-github")).toBeInTheDocument();
  });

  it("badges both curated services as Managed by ShipIt", () => {
    render(<SettingsIntegrations hasActiveSession={false} />);
    expect(screen.getAllByText("Managed by ShipIt").length).toBeGreaterThanOrEqual(2);
  });

  /*
    inventory.md P13, requirement 4. The row used to be rendered inside the
    authenticated branch of the GitHub card, so a disconnected install could not
    see the setting at all — and connecting GitHub is exactly when somebody
    wants to decide it.
  */
  it("shows the auto-create-PR row while GitHub is disconnected", () => {
    render(<SettingsIntegrations hasActiveSession={false} />);
    expect(screen.getByRole("switch", {
      name: GLOBAL_SETTINGS["integrations.autoCreatePr"].label,
    })).toBeInTheDocument();
  });
});
