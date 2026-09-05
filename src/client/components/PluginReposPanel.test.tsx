// docs/262 — the Plugins tab pane: cards, identity, warnings, issue rows.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { PluginReposPanel } from "./PluginReposPanel.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { PluginReposSnapshot } from "../../server/shared/plugin-repos.js";
import type { PluginHostNeed } from "../../server/shared/plugin-hosts.js";
import type { PluginCredentialNeed } from "../../server/shared/plugin-credentials.js";
import type { EgressHostGrantOutcome } from "../../server/shared/types.js";

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
      pinned: false,
      uses: [{ plugin: "probe", alias: "probe", found: true, credentials: [], hosts: [] }],
      issues: [],
    },
    {
      name: "tools",
      source: "nikzlabs/shipit",
      ref: "branch main",
      commit: null,
      status: "active",
      pinned: false,
      uses: [{ plugin: "probe", alias: "remote-probe", found: null, credentials: [], hosts: [] }],
      issues: [],
    },
  ],
};

describe("PluginReposPanel", () => {
  afterEach(() => {
    cleanup();
    setSnapshot(null);
    useSessionStore.setState({ sessionId: undefined });
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

  it("shows a dependency-store notice without calling it a problem", () => {
    // planning#511 — the version is live and whole; what the row says is that
    // every session re-installs its dependencies. A card that counted it as a
    // problem would put a warning chip (and the tab's attention dot) on a plugin
    // with nothing wrong with it, permanently, until its AUTHOR fixed it.
    setSnapshot({
      ...FIXTURE,
      repos: [
        {
          ...FIXTURE.repos[1],
          depStoreNotice: "Dependencies are installed from scratch in every session and never "
            + "shared: `probe`'s install command is not one ShipIt can identify the inputs of.",
        },
      ],
    });
    render(<PluginReposPanel />);
    expect(screen.getByText(/installed from scratch in every session/)).toBeTruthy();
    expect(screen.queryByText("1 problem")).toBeNull();
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
    const withNeeds = (credentials: PluginCredentialNeed[]): PluginReposSnapshot => ({
      ...FIXTURE,
      repos: [
        {
          ...FIXTURE.repos[1],
          uses: [{ plugin: "palette", alias: "artk", found: true, credentials, hosts: [] }],
        },
      ],
    });

    it("names the credential and the plugin that needs it", () => {
      setSnapshot(withNeeds([{ name: "FAL_KEY", satisfied: false, optional: false }]));
      render(<PluginReposPanel />);
      const row = screen.getByTestId("plugin-credential-need-artk-FAL_KEY");
      expect(row.textContent).toContain("FAL_KEY");
      expect(row.textContent).toContain("artk");
      expect(screen.getByText("1 need")).toBeTruthy();
    });

    it("a satisfied credential is stated, not silently dropped", () => {
      // req 23 asks for "which credentials … and whether they are satisfied":
      // a set key is reported quietly; only a gap gets an action row.
      setSnapshot(withNeeds([{ name: "FAL_KEY", satisfied: true, optional: false }]));
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
      setSnapshot(withNeeds([{ name: "FAL_KEY", satisfied: false, optional: false }]));
      render(<PluginReposPanel />);
      fireEvent.click(screen.getByText("Add key…"));

      const ui = useUiStore.getState();
      expect(ui.projectSettingsRepoUrl).toBe("https://github.com/x/y");
      expect(ui.projectSettingsTab).toBe("secrets");
    });

    it("offers no button when the session has no repository to save into", () => {
      setSnapshot({ ...withNeeds([{ name: "FAL_KEY", satisfied: false, optional: false }]), consumerRepoUrl: null });
      render(<PluginReposPanel />);
      expect(screen.getByTestId("plugin-credential-need-artk-FAL_KEY")).toBeTruthy();
      expect(screen.queryByText("Add key…")).toBeNull();
    });

    /**
     * reqs 23, 24 — a key the plugin can use and does not need. The live case:
     * a project deliberately never sets it, and a permanent unmet-need state
     * for a gap the user has already decided not to close is an alarm nobody
     * can clear.
     */
    describe("an OPTIONAL credential", () => {
      it("reads as an offer, not a need, and keeps 'Add key…'", () => {
        setSnapshot(withNeeds([{ name: "PIXELLAB_KEY", satisfied: false, optional: true }]));
        render(<PluginReposPanel />);
        const row = screen.getByTestId("plugin-credential-optional-artk-PIXELLAB_KEY");
        expect(row.textContent).toContain("can use");
        expect(row.textContent).toContain("PIXELLAB_KEY");
        expect(row.textContent).toContain("artk");
        // Not a need: no need row, no need chip.
        expect(screen.queryByTestId("plugin-credential-need-artk-PIXELLAB_KEY")).toBeNull();
        expect(screen.queryByText("1 need")).toBeNull();
        // The user may still want to set it.
        expect(screen.getByText("Add key…")).toBeTruthy();
      });

      it("is counted and worded exactly like a required one once SET", () => {
        // Optionality is about the unsatisfied state alone.
        setSnapshot(withNeeds([{ name: "PIXELLAB_KEY", satisfied: true, optional: true }]));
        render(<PluginReposPanel />);
        expect(screen.queryByTestId("plugin-credential-optional-artk-PIXELLAB_KEY")).toBeNull();
        expect(screen.getByTestId("plugin-credentials-set").textContent).toContain("PIXELLAB_KEY");
      });

      it("leaves a required sibling a need — flip the flag and the row comes back", () => {
        // The guard, run red: the SAME fixture with `optional: false` renders
        // the need row and the chip.
        setSnapshot(
          withNeeds([
            { name: "FAL_KEY", satisfied: false, optional: false },
            { name: "PIXELLAB_KEY", satisfied: false, optional: true },
          ]),
        );
        render(<PluginReposPanel />);
        expect(screen.getByTestId("plugin-credential-need-artk-FAL_KEY")).toBeTruthy();
        expect(screen.getByTestId("plugin-credential-optional-artk-PIXELLAB_KEY")).toBeTruthy();
        expect(screen.getByText("1 need")).toBeTruthy();
      });
    });
  });

  // docs/262 req 24 — the same visibility for declared hosts, plus the grant.
  describe("host needs", () => {
    const withHosts = (hosts: PluginHostNeed[]): PluginReposSnapshot => ({
      ...FIXTURE,
      repos: [
        {
          ...FIXTURE.repos[1],
          uses: [{ plugin: "palette", alias: "artk", found: true, credentials: [], hosts }],
        },
      ],
    });

    it("names the host and the plugin that declares it", () => {
      setSnapshot(withHosts([{ host: "fal.run", reach: "grantable", optional: false }]));
      render(<PluginReposPanel />);
      const row = screen.getByTestId("plugin-host-need-artk-fal.run");
      expect(row.textContent).toContain("fal.run");
      expect(row.textContent).toContain("artk");
      expect(screen.getByText("1 need")).toBeTruthy();
    });

    it("an allowed host is stated, not silently dropped", () => {
      setSnapshot(withHosts([{ host: "fal.run", reach: "allowed", optional: false }]));
      render(<PluginReposPanel />);
      expect(screen.queryByTestId("plugin-host-need-artk-fal.run")).toBeNull();
      expect(screen.queryByText("1 need")).toBeNull();
      const allowed = screen.getByTestId("plugin-hosts-allowed");
      expect(allowed.textContent).toContain("fal.run");
      expect(allowed.textContent).toContain("artk");
    });

    /**
     * planning#383 — a host no user act can reach. The card offered "Allow for
     * session" / "Allow for ShipIt" here, and either one wrote a durable entry
     * that changed nothing: on a deployment with no controlled resolver no
     * grant can take effect, and the user could not learn that from the surface
     * built to answer exactly this question.
     */
    describe("a host no grant can reach", () => {
      it("states the deployment's limit on one row, and offers NO button", () => {
        setSnapshot(withHosts([{ host: "fal.run", reach: "blocked-by-deployment", optional: false }]));
        render(<PluginReposPanel />);
        const row = screen.getByTestId("plugin-hosts-ungrantable");
        expect(row.textContent).toContain("fal.run");
        expect(row.textContent).toContain("can't allow extra hosts");
        // The two lies, by their exact labels.
        expect(screen.queryByText("Allow for session")).toBeNull();
        expect(screen.queryByText("Allow for ShipIt")).toBeNull();
        // And not as a grantable need row either, whose whole content is the grant.
        expect(screen.queryByTestId("plugin-host-need-artk-fal.run")).toBeNull();
      });

      it("names a sealed session instead when that is the reason", () => {
        setSnapshot(withHosts([{ host: "fal.run", reach: "blocked-by-session", optional: false }]));
        render(<PluginReposPanel />);
        const row = screen.getByTestId("plugin-hosts-ungrantable");
        expect(row.textContent).toContain("network access is off");
        expect(screen.queryByText("Allow for session")).toBeNull();
      });

      it("collapses several such hosts into ONE row that names them all", () => {
        setSnapshot(
          withHosts([
            { host: "fal.run", reach: "blocked-by-deployment", optional: false },
            { host: "api.openai.example", reach: "blocked-by-deployment", optional: false },
          ]),
        );
        render(<PluginReposPanel />);
        const rows = screen.getAllByTestId("plugin-hosts-ungrantable");
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain("fal.run");
        expect(rows[0].textContent).toContain("api.openai.example");
      });

      it("is still a need — the gap is visible even though nobody here can close it", () => {
        setSnapshot(withHosts([{ host: "fal.run", reach: "blocked-by-deployment", optional: false }]));
        render(<PluginReposPanel />);
        expect(screen.getByText("1 need")).toBeTruthy();
      });

      it("says so on an OPTIONAL host's own row, with no button", () => {
        // The optional rows are not collapsed into the shared ungrantable row —
        // that row is the alarm, and an optional host is the quiet case.
        setSnapshot(withHosts([{ host: "pixellab.ai", reach: "blocked-by-deployment", optional: true }]));
        render(<PluginReposPanel />);
        expect(screen.queryByTestId("plugin-hosts-ungrantable")).toBeNull();
        const row = screen.getByTestId("plugin-host-optional-artk-pixellab.ai");
        expect(row.textContent).toContain("can use");
        expect(row.textContent).toContain("can't allow extra hosts");
        expect(screen.queryByText("Allow for session")).toBeNull();
        expect(screen.queryByText("1 need")).toBeNull();
        // …and it does NOT claim the host is absent from the allowlist.
        // `blocked-by-deployment` is decided before the allowlist is consulted
        // (`egress-host-reach.ts`), so an already-allowlisted host carries this
        // verdict too and that sentence would be false (review finding).
        expect(row.textContent).not.toContain("egress allowlist");
      });

      it("leaves a grantable host on the same card with its buttons", () => {
        // The two verdicts are per host, so a deployment-blocked host must not
        // take the grant away from one the user really can allow.
        setSnapshot(
          withHosts([
            { host: "fal.run", reach: "blocked-by-session", optional: false },
            { host: "cdn.example", reach: "grantable", optional: false },
          ]),
        );
        render(<PluginReposPanel />);
        expect(screen.getByTestId("plugin-hosts-ungrantable").textContent).toContain("fal.run");
        expect(screen.getByTestId("plugin-host-need-artk-cdn.example")).toBeTruthy();
        expect(screen.getByText("Allow for session")).toBeTruthy();
      });

      /**
       * The reported shape (user, 2026-09-03): a plugin whose FIRST install was
       * denied the network it declared. The card is `unavailable` — no commit,
       * no live generation — and its one issue row is the install failure whose
       * last sentence tells the user to allow those hosts right here.
       *
       * So the buttons must be on THIS card state, not only on a healthy one.
       * The server half (a failed attempt handing its declared hosts to the
       * snapshot) is guarded at `services/plugin-activation.test.ts`; without
       * it `hosts` arrives empty and this card renders the instruction with
       * nothing to obey it with.
       */
      it("puts the buttons on the card the install failure points at", () => {
        setSnapshot({
          ...FIXTURE,
          repos: [
            {
              ...FIXTURE.repos[1],
              status: "unavailable",
              uses: [
                {
                  plugin: "palette",
                  alias: "artk",
                  found: true,
                  credentials: [],
                  hosts: [{ host: "api.pixellab.ai", reach: "grantable", optional: false }],
                },
              ],
              issues: [
                "install for `palette` exited 1: getaddrinfo EAI_AGAIN\n\nThis plugin declares "
                + "`api.pixellab.ai`, which is not in this session's egress allowlist. Allow it on "
                + "this repository's card in the Plugins tab, then refresh the plugin.",
              ],
            },
          ],
        });
        render(<PluginReposPanel />);

        expect(screen.getByTestId("plugin-host-need-artk-api.pixellab.ai")).toBeTruthy();
        expect(screen.getByText("Allow for session")).toBeTruthy();
        expect(screen.getByText("Allow for ShipIt")).toBeTruthy();
        // And the other half of the sentence: a version that failed to activate
        // is still refreshable, so the grant has something to take effect on.
        expect(screen.getByText("Refresh")).toBeTruthy();
      });
    });

    /**
     * reqs 23, 24 — the live case this grammar exists for: a plugin declaring
     * hosts the project deliberately leaves out of its egress allowlist. The
     * gap stays visible and grantable; it just stops reading as a fault.
     */
    it("an OPTIONAL grantable host reads as an offer and keeps both grants", () => {
      setSnapshot(withHosts([{ host: "pixellab.ai", reach: "grantable", optional: true }]));
      render(<PluginReposPanel />);
      const row = screen.getByTestId("plugin-host-optional-artk-pixellab.ai");
      expect(row.textContent).toContain("can use");
      expect(row.textContent).toContain("pixellab.ai");
      expect(screen.queryByTestId("plugin-host-need-artk-pixellab.ai")).toBeNull();
      expect(screen.queryByText("1 need")).toBeNull();
      expect(screen.getByText("Allow for session")).toBeTruthy();
      expect(screen.getByText("Allow for ShipIt")).toBeTruthy();
    });

    it("the same host declared REQUIRED is a need — the flag is what decides", () => {
      // The guard run red: one field flipped, same everything else.
      setSnapshot(withHosts([{ host: "pixellab.ai", reach: "grantable", optional: false }]));
      render(<PluginReposPanel />);
      expect(screen.getByTestId("plugin-host-need-artk-pixellab.ai")).toBeTruthy();
      expect(screen.queryByTestId("plugin-host-optional-artk-pixellab.ai")).toBeNull();
      expect(screen.getByText("1 need")).toBeTruthy();
    });

    it("an optional host that IS allowed behaves exactly like a required one", () => {
      setSnapshot(withHosts([{ host: "pixellab.ai", reach: "allowed", optional: true }]));
      render(<PluginReposPanel />);
      expect(screen.queryByTestId("plugin-host-optional-artk-pixellab.ai")).toBeNull();
      expect(screen.getByTestId("plugin-hosts-allowed").textContent).toContain("pixellab.ai");
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
                credentials: [{ name: "FAL_KEY", satisfied: false, optional: false }],
                hosts: [{ host: "fal.run", reach: "grantable", optional: false }],
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
      const snapshot = withHosts([{ host: "fal.run", reach: "grantable", optional: false }]);
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
        // planning#376 — the session rides along for REPORTING only: the entry
        // still lands at instance scope, and the id says whose surfaces the
        // route should report on.
        expect(grants[1]).toEqual({ host: "fal.run", scope: "global", session: "sess" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // planning#376 — the grant used to say nothing at all: on success the row
    // just disappeared, and the only account of the two scopes' very different
    // behavior was a `title` on the button you had already pressed.
    describe("the outcome is reported after the grant", () => {
      /** Grant, then answer the refetch with a snapshot where the host is allowed. */
      const renderGrant = async (grant: EgressHostGrantOutcome | null, button: string) => {
        const before = withHosts([{ host: "fal.run", reach: "grantable", optional: false }]);
        const after = withHosts([{ host: "fal.run", reach: "allowed", optional: false }]);
        setSnapshot(before);
        // The store drops a snapshot for a session the app isn't on, and the
        // point of this row is that it OUTLIVES the need row the refetch
        // removes — so the refetch has to actually land.
        useSessionStore.setState({ sessionId: "sess" });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((url: string) =>
          url === "/api/egress/hosts"
            ? Promise.resolve({ ok: true, json: async () => ({ grant }) } as Response)
            : Promise.resolve({ ok: true, json: async () => after } as Response)) as typeof fetch;
        render(<PluginReposPanel />);
        fireEvent.click(screen.getByText(button));
        await waitFor(() => expect(screen.queryByTestId("plugin-host-need-artk-fal.run")).toBeNull());
        return () => { globalThis.fetch = originalFetch; };
      };

      it("a session grant confirms it is live everywhere, with no restart offered", async () => {
        const restore = await renderGrant(
          {
            host: "fal.run",
            scope: "session",
            liveNow: ["new-containers", "agent", "services"],
            staleUntilRestart: [],
            restartSessionId: null,
            reach: "grantable",
          },
          "Allow for session",
        );
        try {
          const row = await screen.findByTestId("plugin-host-grant-outcome");
          expect(row.textContent).toContain("fal.run");
          expect(row.textContent).toContain("No restart needed");
          expect(screen.queryByText("Restart to apply now")).toBeNull();
        } finally {
          restore();
        }
      });

      it("a global grant names the agent and services as stale and offers the restart", async () => {
        const restore = await renderGrant(
          {
            host: "fal.run",
            scope: "global",
            liveNow: ["new-containers"],
            staleUntilRestart: ["agent", "services"],
            restartSessionId: "sess",
            reach: "grantable",
          },
          "Allow for ShipIt",
        );
        try {
          const row = await screen.findByTestId("plugin-host-grant-outcome");
          // The tooltip named services only; the agent is equally stale.
          expect(row.textContent).toContain("agent");
          expect(row.textContent).toContain("running service");
          expect(screen.getByText("Restart to apply now")).toBeTruthy();
        } finally {
          restore();
        }
      });

      // The 503 is "allowlist saved, but the live service refresh failed
      // closed" — the host IS durably allowed, so the refetch removes the need
      // row and any message kept on it would vanish with it. That is the same
      // silent disappearance the issue is about, so the account moves to the
      // card, where it survives.
      it("a failed grant is reported on the card, not on the row that unmounts", async () => {
        const before = withHosts([{ host: "fal.run", reach: "grantable", optional: false }]);
        const after = withHosts([{ host: "fal.run", reach: "allowed", optional: false }]);
        setSnapshot(before);
        useSessionStore.setState({ sessionId: "sess" });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((url: string) =>
          url === "/api/egress/hosts"
            ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response)
            : Promise.resolve({ ok: true, json: async () => after } as Response)) as typeof fetch;
        try {
          render(<PluginReposPanel />);
          fireEvent.click(screen.getByText("Allow for session"));
          await waitFor(() => expect(screen.queryByTestId("plugin-host-need-artk-fal.run")).toBeNull());
          const failed = await screen.findByTestId("plugin-host-grant-failed");
          expect(failed.textContent).toContain("fal.run");
          expect(failed.textContent).toContain("without the live refresh");
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      it("says nothing when the server reported no outcome (an older orchestrator)", async () => {
        const restore = await renderGrant(null, "Allow for session");
        try {
          expect(screen.queryByTestId("plugin-host-grant-outcome")).toBeNull();
        } finally {
          restore();
        }
      });
    });
  });

  // req 12 — "the user or the agent can request a plugin refresh". The agent's
  // half has been a shim verb since the feature shipped; this is the user's.
  describe("refreshing a repository from the card (req 12)", () => {
    const card = (over: Partial<PluginReposSnapshot["repos"][number]> = {}) => ({
      declared: true,
      pending: false,
      activating: false,
      consumerRepoUrl: "https://github.com/x/y",
      warnings: [],
      repos: [
        {
          name: "tools",
          source: "a/b",
          ref: "branch main",
          commit: "abcdef0123",
          status: "active" as const,
          pinned: false,
          uses: [],
          issues: [],
          ...over,
        },
      ],
    });

    /** Answer the refresh with `row`, then every refetch with the same card. */
    const stub = (
      row: Record<string, unknown> | null,
      snapshot: PluginReposSnapshot,
    ): { calls: { url: string; body: unknown }[]; restore: () => void } => {
      const calls: { url: string; body: unknown }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((url: string, init?: RequestInit) => {
        calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
        return url.endsWith("/plugin/refresh")
          ? Promise.resolve({
            ok: row !== null,
            status: row === null ? 400 : 200,
            json: async () => (row === null ? { error: "fetch denied" } : { rows: [row] }),
          } as Response)
          : Promise.resolve({ ok: true, status: 200, json: async () => snapshot } as Response);
      }) as typeof fetch;
      return { calls, restore: () => { globalThis.fetch = originalFetch; } };
    };

    it("offers Refresh on a branch-tracking repository and posts its name", async () => {
      const snapshot = card();
      setSnapshot(snapshot);
      const { calls, restore } = stub({ status: "activated", before: "abcdef0123", after: "9876543210" }, snapshot);
      try {
        render(<PluginReposPanel />);
        fireEvent.click(screen.getByText("Refresh"));
        await waitFor(() => expect(screen.getByTestId("plugin-refresh-outcome")).toBeTruthy());
        expect(calls[0].url).toBe("/api/sessions/sess/plugin/refresh");
        expect(calls[0].body).toEqual({ repo: "tools" });
      } finally {
        restore();
      }
    });

    // req 8 — a pinned project "stays at that exact revision until its
    // declaration changes", so a Refresh here could only ever report "already
    // at". The card says why instead of leaving a button-shaped hole.
    it("offers no Refresh on a pinned repository, and says what does move it", () => {
      setSnapshot(card({ pinned: true, ref: "pin v1.2.0" }));
      render(<PluginReposPanel />);
      expect(screen.queryByText("Refresh")).toBeNull();
      expect(screen.getByText(/Pinned to an exact revision/)).toBeTruthy();
    });

    // req 27 — a self-declared repository IS the working tree; edits are live
    // and there is no version to fetch. Ratified in the mockup before the tab
    // was built ("No Refresh button: edits apply live").
    it("offers no Refresh on a self-declared repository", () => {
      setSnapshot(card({ source: "self", status: "self", ref: null, commit: null }));
      render(<PluginReposPanel />);
      expect(screen.queryByText("Refresh")).toBeNull();
    });

    // The one outcome that changes NOTHING on the card. Without a reported
    // answer the button would look broken in exactly the case where it worked
    // and there was simply nothing to do.
    it("reports 'already at' when the tracked tip is what is already live", async () => {
      const snapshot = card();
      setSnapshot(snapshot);
      const { restore } = stub({ status: "unchanged", before: "abcdef0123", after: "abcdef0123" }, snapshot);
      try {
        render(<PluginReposPanel />);
        fireEvent.click(screen.getByText("Refresh"));
        await waitFor(() => expect(screen.getByText(/nothing to update/)).toBeTruthy());
        // Scoped to the row: the header chip carries the same commit, and the
        // point here is that the ANSWER names it.
        expect(screen.getByTestId("plugin-refresh-outcome").textContent).toContain("abcdef012");
      } finally {
        restore();
      }
    });

    // An activation failure is a 200 carrying `{status:"failed", after:"<prior
    // commit>"}` — req 15 keeps the prior generation whole and live, so what
    // the user most needs is which version they are still on. An earlier
    // version of this test used the 400 shape below, which carries no `after`
    // at all, and so passed with the "still on" rendering deleted (independent
    // review).
    it("reports a failed round and names the commit still live (req 15)", async () => {
      const snapshot = card();
      setSnapshot(snapshot);
      const { restore } = stub(
        { status: "failed", before: "abcdef0123", after: "abcdef0123", detail: "install exited 1" },
        snapshot,
      );
      try {
        render(<PluginReposPanel />);
        fireEvent.click(screen.getByText("Refresh"));
        await waitFor(() => expect(screen.getByTestId("plugin-refresh-outcome")).toBeTruthy());
        const row = screen.getByTestId("plugin-refresh-outcome");
        expect(row.textContent).toContain("Refresh failed");
        expect(row.textContent).toContain("still on");
        expect(row.textContent).toContain("abcdef012");
        expect(row.textContent).toContain("install exited 1");
      } finally {
        restore();
      }
    });

    // The other failure shape: the request never produced a row. A 400 (a name
    // the declaration does not have) and a 501 (a runtime with no refresh hook)
    // both land here, and from the user's side they are the same event.
    it("reports a refused request too, rather than going silent", async () => {
      const snapshot = card();
      setSnapshot(snapshot);
      const { restore } = stub(null, snapshot);
      try {
        render(<PluginReposPanel />);
        fireEvent.click(screen.getByText("Refresh"));
        await waitFor(() => expect(screen.getByTestId("plugin-refresh-outcome")).toBeTruthy());
        expect(screen.getByText(/Refresh failed/)).toBeTruthy();
        expect(screen.getByText("fetch denied")).toBeTruthy();
      } finally {
        restore();
      }
    });

    // Refresh IS the activation round, one serial queue per repository — a
    // second press would queue behind the first and report on it.
    it("disables the button while a round is already running", () => {
      setSnapshot(card({ status: "activating" }));
      render(<PluginReposPanel />);
      expect(screen.getByText("Refresh").closest("button")?.disabled).toBe(true);
    });
  });
});
