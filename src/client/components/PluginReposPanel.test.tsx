// docs/262 — the Plugins tab pane: cards, identity, warnings, issue rows.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { PluginReposPanel } from "./PluginReposPanel.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { PluginReposSnapshot } from "../../server/shared/plugin-repos.js";

function setSnapshot(snapshot: PluginReposSnapshot | null) {
  usePluginReposStore.setState({ snapshot, forSessionId: snapshot ? "sess" : null });
}

const FIXTURE: PluginReposSnapshot = {
  declared: true,
  pending: false,
  activating: false,
  consumerRepoUrl: "https://github.com/x/y",
  warnings: [],
  repos: [
    {
      name: "shipit-dev",
      source: "self",
      ref: null,
      commit: null,
      status: "self",
      uses: [{ plugin: "probe", alias: "probe", found: true, credentials: [] }],
      issues: [],
    },
    {
      name: "tools",
      source: "nikzlabs/shipit",
      ref: "main",
      commit: null,
      status: "active",
      uses: [{ plugin: "probe", alias: "remote-probe", found: null, credentials: [] }],
      issues: [],
    },
  ],
};

describe("PluginReposPanel", () => {
  afterEach(() => {
    cleanup();
    setSnapshot(null);
    useUiStore.getState().setProjectSettingsRepoUrl(null);
  });

  it("renders one card per declared repo with the identity always visible (req 19)", () => {
    setSnapshot(FIXTURE);
    render(<PluginReposPanel />);
    expect(screen.getByText("shipit-dev")).toBeTruthy();
    expect(screen.getByText("self · live working tree")).toBeTruthy();
    expect(screen.getByText("tools")).toBeTruthy();
    expect(screen.getByText("nikzlabs/shipit")).toBeTruthy();
    // Tracked repos show ref @ commit even before a commit exists.
    expect(screen.getByText("main @ —")).toBeTruthy();
  });

  it("shows what each repo's plugins are used as", () => {
    setSnapshot(FIXTURE);
    render(<PluginReposPanel />);
    expect(screen.getByText("remote-probe")).toBeTruthy();
  });

  it("renders parse warnings as their own block (req 13)", () => {
    setSnapshot({ ...FIXTURE, repos: [], warnings: ["Unknown key `plugins.foo` in shipit.yaml."] });
    render(<PluginReposPanel />);
    expect(screen.getByText(/Declaration problems/)).toBeTruthy();
    expect(screen.getByText(/plugins.foo/)).toBeTruthy();
  });

  it("renders per-repo issue rows and the problems chip", () => {
    setSnapshot({
      ...FIXTURE,
      repos: [
        {
          ...FIXTURE.repos[0],
          uses: [{ plugin: "ghost", alias: "ghost", found: false, credentials: [] }],
          issues: ["`ghost` is not in this repository's `exports.plugins` manifest."],
        },
      ],
    });
    render(<PluginReposPanel />);
    expect(screen.getByText("1 problem")).toBeTruthy();
    expect(screen.getByText(/is not in this repository's/)).toBeTruthy();
    // The backticks are markup, not characters: the same strings are read in a
    // terminal by `shipit plugin refresh`, so they stay in the string and the
    // row renders them (found in the dogfood reading "`probe` declares…").
    expect(screen.getAllByText("exports.plugins")[0].tagName).toBe("CODE");
    expect(screen.queryByText(/`exports\.plugins`/)).toBeNull();
  });

  it("a files-only repo says so", () => {
    setSnapshot({ ...FIXTURE, repos: [{ ...FIXTURE.repos[1], uses: [] }] });
    render(<PluginReposPanel />);
    expect(screen.getByText(/files only — no plugins activated/)).toBeTruthy();
  });

  // docs/262 req 23 — a missing key is a visible, NAMED gap.
  describe("credential needs", () => {
    const withNeeds = (credentials: { name: string; satisfied: boolean }[]): PluginReposSnapshot => ({
      ...FIXTURE,
      repos: [
        {
          ...FIXTURE.repos[1],
          uses: [{ plugin: "palette", alias: "artk", found: true, credentials }],
        },
      ],
    });

    it("names the credential and the plugin that needs it", () => {
      setSnapshot(withNeeds([{ name: "FAL_KEY", satisfied: false }]));
      render(<PluginReposPanel />);
      const row = screen.getByTestId("plugin-credential-need-artk-FAL_KEY");
      expect(row.textContent).toContain("FAL_KEY");
      expect(row.textContent).toContain("artk");
      expect(screen.getByText("1 need")).toBeTruthy();
    });

    it("a satisfied credential is stated, not silently dropped", () => {
      // req 23 asks for "which credentials … and whether they are satisfied":
      // a set key is reported quietly; only a gap gets an action row.
      setSnapshot(withNeeds([{ name: "FAL_KEY", satisfied: true }]));
      render(<PluginReposPanel />);
      expect(screen.queryByTestId("plugin-credential-need-artk-FAL_KEY")).toBeNull();
      expect(screen.queryByText("1 need")).toBeNull();
      const set = screen.getByTestId("plugin-credentials-set");
      expect(set.textContent).toContain("FAL_KEY");
      expect(set.textContent).toContain("artk");
    });

    it("'Add key…' opens the CONSUMING project's secret store, never the plugin repo's", () => {
      // plan §3's store trap: `setProjectSettingsRepoUrl` selects the store
      // `/api/secrets` writes to, so the plugin repository's URL would save the
      // key where nothing reads it.
      setSnapshot(withNeeds([{ name: "FAL_KEY", satisfied: false }]));
      render(<PluginReposPanel />);
      fireEvent.click(screen.getByText("Add key…"));

      const ui = useUiStore.getState();
      expect(ui.projectSettingsRepoUrl).toBe("https://github.com/x/y");
      expect(ui.projectSettingsTab).toBe("secrets");
    });

    it("offers no button when the session has no repository to save into", () => {
      setSnapshot({ ...withNeeds([{ name: "FAL_KEY", satisfied: false }]), consumerRepoUrl: null });
      render(<PluginReposPanel />);
      expect(screen.getByTestId("plugin-credential-need-artk-FAL_KEY")).toBeTruthy();
      expect(screen.queryByText("Add key…")).toBeNull();
    });
  });
});
