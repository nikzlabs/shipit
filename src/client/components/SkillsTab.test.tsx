/**
 * Component tests for SkillsTab (docs/149 v1c).
 *
 * Exercises:
 *  - Discover renders the seeded catalog's plugin list.
 *  - The install sheet's repo picker + repo-targeted install (app-wide route,
 *    NOT the session-scoped route).
 *  - Install is disabled when no repository is available.
 *  - Codex agent shows the v1b "Claude-only for now" empty state.
 *  - Per-marketplace fetch-failed Retry row.
 *
 * Stubs fetch via a tiny capture-and-respond double (same shape as
 * McpServerSettings.test.tsx). Monaco mount is mocked because the install
 * sheet uses `import("monaco-editor")` and Monaco can't run in jsdom.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SkillsTab } from "./SkillsTab.js";
import { useSkillsStore } from "../stores/skills-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { MarketplaceInfo, PluginInfo, RepoInfo } from "../../server/shared/types.js";

vi.mock("monaco-editor", () => ({
  editor: {
    create: vi.fn(() => ({ dispose: vi.fn(), setValue: vi.fn() })),
  },
}));

const originalFetch = globalThis.fetch;

class FakeFetch {
  routes: { match: RegExp; method: string; respond: (body: unknown) => unknown }[] = [];
  calls: { method: string; url: string }[] = [];

  on(method: string, match: RegExp, respond: (body: unknown) => unknown): this {
    this.routes.push({ method, match, respond });
    return this;
  }

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const method = init?.method ?? "GET";
      this.calls.push({ method, url });
      const route = this.routes.find((r) => r.method === method && r.match.test(url));
      if (!route) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: `no fake route for ${method} ${url}` }), {
            status: 404,
          }),
        );
      }
      const body = route.respond(init?.body);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;
  }
}

const fakeMarketplace: MarketplaceInfo = {
  id: "claude-plugins-official",
  source: { kind: "github", ownerRepo: "anthropics/claude-plugins-official" },
  agentId: "claude",
  autoUpdate: true,
  status: "ok",
};

const fakePlugin: PluginInfo = {
  marketplaceId: "claude-plugins-official",
  name: "demo-plugin",
  description: "A demo plugin",
  author: "Anthropic",
  skills: [{ name: "hello", description: "say hi" }],
  estimatedContextBytes: 256,
};

const fakeRepo: RepoInfo = {
  url: "https://github.com/acme/widgets.git",
  addedAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
  status: "ready",
};

/** Seed the catalog routes shared by most tests. */
function catalogRoutes(fake: FakeFetch): FakeFetch {
  fake.on("GET", /\/api\/marketplaces\?agent=claude/, () => ({ marketplaces: [fakeMarketplace] }));
  fake.on("GET", /\/api\/marketplaces\/[^/]+\/plugins$/, () => ({
    plugins: [fakePlugin],
    marketplace: fakeMarketplace,
  }));
  fake.on("GET", /\/skills\/hello$/, () => ({ content: "# hello skill" }));
  return fake;
}

describe("SkillsTab (docs/149 v1c)", () => {
  beforeEach(() => {
    useSkillsStore.getState().reset();
    useUiStore.setState({ activeAgentId: "claude" });
    useRepoStore.setState({ repos: [fakeRepo], activeRepoUrl: fakeRepo.url });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the Discover list from the seeded catalog", async () => {
    catalogRoutes(new FakeFetch()).install();

    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("skills-discover-list")).toBeInTheDocument();
    });
    expect(screen.getByText("demo-plugin")).toBeInTheDocument();
    expect(screen.getByText(/A demo plugin/)).toBeInTheDocument();
    expect(screen.getByTestId("skills-install-demo-plugin")).toBeInTheDocument();
  });

  it("install sheet targets a repo and posts a repo-scoped install (no session route)", async () => {
    const fake = catalogRoutes(new FakeFetch());
    fake.on("POST", /\/api\/plugins\/install$/, () => ({
      sessionId: "new-install-session",
      branch: "shipit/install-demo-plugin-abc",
      pr: { number: 42, url: "https://github.com/acme/widgets/pull/42" },
      installedDirs: ["/ws/.claude/skills/demo-plugin__hello"],
    }));
    fake.install();

    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("skills-install-demo-plugin")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("skills-install-demo-plugin"));

    // The install sheet renders a repo picker defaulted to the active repo.
    await waitFor(() => {
      expect(screen.getByTestId("skill-install-repo-select")).toBeInTheDocument();
    });
    expect(screen.getByTestId("skill-install-confirm")).toBeEnabled();

    fireEvent.click(screen.getByTestId("skill-install-confirm"));

    // It hits the app-wide repo-targeted route, NOT a session-scoped route.
    await waitFor(() => {
      expect(fake.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/plugins/install"))).toBe(true);
    });
    expect(
      fake.calls.some((c) => c.url.includes("/sessions/") && c.url.endsWith("/plugins/install")),
    ).toBe(false);
  });

  it("disables install when no repository is available", async () => {
    useRepoStore.setState({ repos: [], activeRepoUrl: undefined });
    catalogRoutes(new FakeFetch()).install();

    render(<SkillsTab />);
    await waitFor(() => {
      expect(screen.getByTestId("skills-install-demo-plugin")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("skills-install-demo-plugin"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-install-sheet")).toBeInTheDocument();
    });
    expect(screen.getByTestId("skill-install-confirm")).toBeDisabled();
  });

  it("shows the Claude-only empty state when the active agent is Codex", () => {
    useUiStore.setState({ activeAgentId: "codex" });
    render(<SkillsTab />);
    expect(screen.getByText(/Skill discovery and install/i)).toBeInTheDocument();
    expect(screen.getByText(/Codex support is/i)).toBeInTheDocument();
  });

  it("Discover renders a Retry button per fetch-failed marketplace", async () => {
    const failed: MarketplaceInfo = {
      ...fakeMarketplace,
      status: "fetch-failed",
      fetchError: "connection refused",
    };
    const fake = new FakeFetch();
    fake.on("GET", /\/api\/marketplaces\?agent=claude/, () => ({ marketplaces: [failed] }));
    fake.on("GET", /\/api\/marketplaces\/[^/]+\/plugins$/, () => ({ plugins: [], marketplace: failed }));
    fake.install();

    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
