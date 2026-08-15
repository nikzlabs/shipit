// docs/262 — the Plugins tab pane: cards, identity, warnings, issue rows.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
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
      uses: [{ plugin: "probe", alias: "probe", found: true, credentials: [], hosts: [] }],
      issues: [],
    },
    {
      name: "tools",
      source: "nikzlabs/shipit",
      ref: "branch main",
      commit: null,
      status: "active",
      uses: [{ plugin: "probe", alias: "remote-probe", found: null, credentials: [], hosts: [] }],
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
    expect(screen.getByText("branch main @ —")).toBeTruthy();
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
          uses: [{ plugin: "ghost", alias: "ghost", found: false, credentials: [], hosts: [] }],
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

  // The `active` footer once said those things "land with the remaining plugin
  // mechanics (docs/262)" — tab v0's honest placeholder, still there after they
  // shipped, so an active card denied its own features (found in the dogfood).
  // It must also not assert that all four already AGREE: the refetch that draws
  // this card is emitted before the container prepare and the service reconcile
  // are fired (review finding), so they follow rather than being done.
  it("the active footer states the checkout as fact and the rest as following", () => {
    setSnapshot({ ...FIXTURE, repos: [FIXTURE.repos[1]] });
    render(<PluginReposPanel />);
    expect(screen.getByText(/Checked out at this exact commit\./)).toBeTruthy();
    expect(screen.getByText(/anything that could not be updated is reported above/)).toBeTruthy();
    expect(screen.queryByText(/remaining plugin mechanics/)).toBeNull();
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
          uses: [{ plugin: "palette", alias: "artk", found: true, credentials, hosts: [] }],
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

  // docs/262 req 24 — the same visibility for declared hosts, plus the grant.
  describe("host needs", () => {
    const withHosts = (hosts: { host: string; allowed: boolean }[]): PluginReposSnapshot => ({
      ...FIXTURE,
      repos: [
        {
          ...FIXTURE.repos[1],
          uses: [{ plugin: "palette", alias: "artk", found: true, credentials: [], hosts }],
        },
      ],
    });

    it("names the host and the plugin that declares it", () => {
      setSnapshot(withHosts([{ host: "fal.run", allowed: false }]));
      render(<PluginReposPanel />);
      const row = screen.getByTestId("plugin-host-need-artk-fal.run");
      expect(row.textContent).toContain("fal.run");
      expect(row.textContent).toContain("artk");
      expect(screen.getByText("1 need")).toBeTruthy();
    });

    it("an allowed host is stated, not silently dropped", () => {
      setSnapshot(withHosts([{ host: "fal.run", allowed: true }]));
      render(<PluginReposPanel />);
      expect(screen.queryByTestId("plugin-host-need-artk-fal.run")).toBeNull();
      expect(screen.queryByText("1 need")).toBeNull();
      const allowed = screen.getByTestId("plugin-hosts-allowed");
      expect(allowed.textContent).toContain("fal.run");
      expect(allowed.textContent).toContain("artk");
    });

    it("credential gaps and host gaps count toward one needs chip", () => {
      setSnapshot({
        ...FIXTURE,
        repos: [
          {
            ...FIXTURE.repos[1],
            uses: [
              {
                plugin: "palette",
                alias: "artk",
                found: true,
                credentials: [{ name: "FAL_KEY", satisfied: false }],
                hosts: [{ host: "fal.run", allowed: false }],
              },
            ],
          },
        ],
      });
      render(<PluginReposPanel />);
      expect(screen.getByText("2 needs")).toBeTruthy();
    });

    // req 24: the grant is a deliberate user act on the USER's egress
    // allowlist, at one of the two scopes the requirement names — never
    // anything plugin-local, and never a side effect of the declaration.
    it("each scope posts to the existing egress route with that scope", async () => {
      const snapshot = withHosts([{ host: "fal.run", allowed: false }]);
      setSnapshot(snapshot);
      const grants: unknown[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((url: string, init?: RequestInit) => {
        if (url === "/api/egress/hosts") {
          grants.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
        }
        // The store refetches its own snapshot after a grant; answering with the
        // same one keeps the row rendered so the second scope can be clicked.
        return Promise.resolve({ ok: true, json: async () => snapshot } as Response);
      }) as typeof fetch;
      try {
        render(<PluginReposPanel />);
        fireEvent.click(screen.getByText("Allow for session"));
        await waitFor(() => expect(grants).toHaveLength(1));
        // Session scope travels as the session id — the shape `/api/egress/hosts`
        // reads as "this session's extras" (`global` is the reserved word).
        expect(grants[0]).toEqual({ host: "fal.run", scope: "sess" });

        fireEvent.click(screen.getByText("Allow for ShipIt"));
        await waitFor(() => expect(grants).toHaveLength(2));
        expect(grants[1]).toEqual({ host: "fal.run", scope: "global" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
