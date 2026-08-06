/**
 * Component tests for SettingsTrackers — the Linear card in workspace-wide
 * Settings → Integrations.
 *
 * The load-bearing assertion here is a *scope* one, not a rendering one: this
 * card is workspace-scoped, so it must show the credential and nothing that
 * belongs to a particular repository. After the docs/248 tracker migration it
 * carried a `shipit.yaml` tracker-declaration snippet, which is per-repository
 * configuration in a dialog that has no repository — repo-scoped surfaces are
 * the Project Settings dialog and the Issues tab's declared sub-tabs.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SettingsTrackers } from "./SettingsTrackers.js";

const originalFetch = globalThis.fetch;

/** Stubs the teams lookup that drives connected-vs-disconnected state. */
function installFetchStub(teams: { id: string; key: string; name: string }[] | null) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;
    if (url.includes("/api/trackers/linear/teams")) {
      // A missing credential answers 400 ("Connect Linear first"), which the
      // card reads as disconnected rather than as an error.
      return Promise.resolve(
        teams
          ? new Response(JSON.stringify({ teams }), { status: 200 })
          : new Response(JSON.stringify({ error: "Connect Linear first" }), { status: 400 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }) as typeof fetch;
}

describe("SettingsTrackers", () => {
  beforeEach(() => {
    installFetchStub([{ id: "t1", key: "SHI", name: "ShipIt" }]);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("shows the teams the credential can reach when connected", async () => {
    render(<SettingsTrackers />);
    await waitFor(() => expect(screen.getByTestId("linear-connected")).toBeInTheDocument());
    expect(screen.getByText("SHI")).toBeInTheDocument();
    expect(screen.getByText("ShipIt")).toBeInTheDocument();
  });

  it("shows no repository-scoped tracker declaration in workspace settings", async () => {
    const { container } = render(<SettingsTrackers />);
    await waitFor(() => expect(screen.getByTestId("linear-connected")).toBeInTheDocument());
    // No config block, and no fragment of the `issues.trackers` declaration
    // that lives in a repository's shipit.yaml.
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("shipit.yaml");
    expect(container.textContent).not.toContain("kind: linear");
    expect(container.textContent).not.toContain("trackers:");
  });

  it("falls back to the connect form when no credential is stored", async () => {
    installFetchStub(null);
    render(<SettingsTrackers />);
    await waitFor(() => expect(screen.getByTestId("linear-token-input")).toBeInTheDocument());
    expect(screen.queryByTestId("linear-connected")).toBeNull();
  });
});
