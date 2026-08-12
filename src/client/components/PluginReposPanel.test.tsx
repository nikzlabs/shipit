// docs/262 — the Plugins tab pane: cards, identity, warnings, issue rows.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { PluginReposPanel } from "./PluginReposPanel.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
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
      uses: [{ plugin: "probe", alias: "probe", found: true }],
      issues: [],
    },
    {
      name: "tools",
      source: "nikzlabs/shipit",
      ref: "main",
      commit: null,
      status: "active",
      uses: [{ plugin: "probe", alias: "remote-probe", found: null }],
      issues: [],
    },
  ],
};

describe("PluginReposPanel", () => {
  afterEach(() => {
    cleanup();
    setSnapshot(null);
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
          uses: [{ plugin: "ghost", alias: "ghost", found: false }],
          issues: ["`ghost` is not in this repository's `exports.plugins` manifest."],
        },
      ],
    });
    render(<PluginReposPanel />);
    expect(screen.getByText("1 problem")).toBeTruthy();
    expect(screen.getByText(/is not in this repository's/)).toBeTruthy();
  });

  it("a files-only repo says so", () => {
    setSnapshot({ ...FIXTURE, repos: [{ ...FIXTURE.repos[1], uses: [] }] });
    render(<PluginReposPanel />);
    expect(screen.getByText(/files only — no plugins activated/)).toBeTruthy();
  });
});
