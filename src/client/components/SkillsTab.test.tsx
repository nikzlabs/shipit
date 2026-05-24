/**
 * Component tests for SkillsTab (docs/149).
 *
 * Exercises:
 *  - Discover sub-tab renders the seeded catalog's plugin list.
 *  - Switching to Installed shows ShipIt-managed entries.
 *  - Codex agent shows the v1b "Claude-only for now" empty state.
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
import { useSessionStore } from "../stores/session-store.js";
import type { MarketplaceInfo, PluginInfo } from "../../server/shared/types.js";

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

describe("SkillsTab (docs/149)", () => {
  beforeEach(() => {
    useSkillsStore.getState().reset();
    useUiStore.setState({ activeAgentId: "claude" });
    useSessionStore.setState({ sessionId: "test-session" });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the Discover list from the seeded catalog", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /\/api\/marketplaces\?agent=claude/, () => ({
      marketplaces: [fakeMarketplace],
    }));
    fake.on("GET", /\/api\/marketplaces\/[^/]+\/plugins$/, () => ({
      plugins: [fakePlugin],
      marketplace: fakeMarketplace,
    }));
    fake.on("GET", /\/api\/sessions\/[^/]+\/plugins$/, () => ({ plugins: [] }));
    fake.install();

    render(<SkillsTab hasActiveSession />);

    await waitFor(() => {
      expect(screen.getByTestId("skills-discover-list")).toBeInTheDocument();
    });
    expect(screen.getByText("demo-plugin")).toBeInTheDocument();
    expect(screen.getByText(/A demo plugin/)).toBeInTheDocument();
    expect(screen.getByTestId("skills-install-demo-plugin")).toBeInTheDocument();
  });

  it("Installed sub-tab lists ShipIt-managed installs", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /\/api\/marketplaces\?agent=claude/, () => ({
      marketplaces: [fakeMarketplace],
    }));
    fake.on("GET", /\/api\/marketplaces\/[^/]+\/plugins$/, () => ({
      plugins: [fakePlugin],
      marketplace: fakeMarketplace,
    }));
    fake.on("GET", /\/api\/sessions\/[^/]+\/plugins$/, () => ({
      plugins: [
        {
          marketplaceId: "claude-plugins-official",
          pluginName: "demo-plugin",
          skillName: "hello",
          version: "head",
          installedAt: new Date().toISOString(),
          directory: "/ws/.claude/skills/demo-plugin__hello",
        },
      ],
    }));
    fake.install();

    render(<SkillsTab hasActiveSession />);

    await waitFor(() => {
      expect(screen.getByTestId("skills-subtab-installed")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("skills-subtab-installed"));

    await waitFor(() => {
      expect(screen.getByTestId("skills-installed-list")).toBeInTheDocument();
    });
    expect(screen.getByText("demo-plugin")).toBeInTheDocument();
    expect(screen.getByText(/\/demo-plugin:hello/)).toBeInTheDocument();
    expect(screen.getByTestId("skills-uninstall-demo-plugin")).toBeInTheDocument();
  });

  it("shows the Claude-only empty state when the active agent is Codex", () => {
    useUiStore.setState({ activeAgentId: "codex" });
    render(<SkillsTab hasActiveSession />);
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
    fake.on("GET", /\/api\/marketplaces\/[^/]+\/plugins$/, () => ({
      plugins: [],
      marketplace: failed,
    }));
    fake.on("GET", /\/api\/sessions\/[^/]+\/plugins$/, () => ({ plugins: [] }));
    fake.install();

    render(<SkillsTab hasActiveSession />);

    await waitFor(() => {
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
