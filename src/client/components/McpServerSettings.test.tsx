/**
 * Component tests for McpServerSettings (docs/088).
 *
 * Exercises the rendered server list, the add/edit form's validation
 * messages, the per-server status badge driven by useMcpStore.statuses,
 * and the disabled "Test" button when no session is active.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { McpServerSettings } from "./McpServerSettings.js";
import { useMcpStore } from "../stores/mcp-store.js";
import type { McpServerConfig } from "../../server/shared/types.js";

const stdioConfig: McpServerConfig = {
  name: "linear",
  type: "stdio",
  command: "npx",
  args: ["-y", "@anthropic-ai/linear-mcp"],
  env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
  enabled: true,
};

const originalFetch = globalThis.fetch;

// Capture-and-respond fetch double. The component mounts useEffect that calls
// `fetchServers()`, so every test needs a GET handler for /api/mcp-servers.
class FakeFetch {
  routes: { match: RegExp; method: string; respond: (body: unknown) => { status?: number; body: unknown } }[] = [];
  calls: { method: string; url: string; body?: unknown }[] = [];

  on(method: string, match: RegExp, respond: (body: unknown) => unknown): this {
    this.routes.push({
      match,
      method,
      respond: (body) => {
        const r = respond(body) as { status?: number; body: unknown };
        if (r && typeof r === "object" && "body" in r) return r;
        return { status: 200, body: r };
      },
    });
    return this;
  }

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
      this.calls.push({ method, url, body });
      const route = this.routes.find((r) => r.method === method && r.match.test(url));
      if (!route) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: `no fake route for ${method} ${url}` }), { status: 404 }),
        );
      }
      const { status = 200, body: respBody } = route.respond(body);
      return Promise.resolve(new Response(JSON.stringify(respBody), { status }));
    }) as typeof fetch;
  }
}

describe("McpServerSettings (docs/088)", () => {
  beforeEach(() => {
    useMcpStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the empty state when no servers exist", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
    });
  });

  it("lists existing servers and shows the add button", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [stdioConfig] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });
    expect(screen.getByTestId("mcp-add-server")).toBeInTheDocument();
  });

  it("renders a per-server status badge from useMcpStore.statuses", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [stdioConfig] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });

    useMcpStore.getState().applyStatus("linear", "failed", "missing secret: LINEAR_API_KEY");

    await waitFor(() => {
      expect(screen.getByText(/failed — missing secret: LINEAR_API_KEY/)).toBeInTheDocument();
    });
  });

  it("disables the Test button when no session is active", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [stdioConfig] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });
    const testBtn = screen.getByRole("button", { name: "Test" });
    expect(testBtn).toBeDisabled();
  });

  it("shows the add form when '+ Add MCP Server' is clicked", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-add-server")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("mcp-add-server"));
    expect(screen.getByTestId("mcp-server-form")).toBeInTheDocument();
    expect(screen.getByText("Add MCP Server")).toBeInTheDocument();
  });

  it("surfaces a validation error for invalid names", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-add-server")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("mcp-add-server"));

    // Type an invalid name (uppercase + hyphen).
    const nameInput = screen.getByPlaceholderText("linear");
    fireEvent.change(nameInput, { target: { value: "Bad-Name" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Name must be lowercase alphanumeric/),
      ).toBeInTheDocument();
    });
  });

  it("requires a command for stdio servers", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    fireEvent.click(await screen.findByTestId("mcp-add-server"));

    fireEvent.change(screen.getByPlaceholderText("linear"), {
      target: { value: "ok" },
    });
    // Empty the prefilled command field.
    const commandInput = screen.getByPlaceholderText("npx") as HTMLInputElement;
    fireEvent.change(commandInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Command is required for stdio servers/),
      ).toBeInTheDocument();
    });
  });

  it("displays the store-level error banner when one is set", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({
      status: 500,
      body: { error: "backend unavailable" },
    }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);

    await waitFor(() => {
      expect(screen.getByText("backend unavailable")).toBeInTheDocument();
    });
  });

  it("populates the form when editing an existing server (secrets are NOT echoed)", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [stdioConfig] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // The form header reflects the editing state.
    expect(screen.getByText('Edit "linear"')).toBeInTheDocument();

    // The env-var key is preserved, but the value field is empty (no secret echo).
    expect((screen.getByDisplayValue("LINEAR_API_KEY") as HTMLInputElement).value).toBe(
      "LINEAR_API_KEY",
    );
    // The password input for the value should be empty — secrets are never echoed.
    const valueInputs = screen.getAllByPlaceholderText("(unchanged)");
    expect(valueInputs).toHaveLength(1);
    expect((valueInputs[0] as HTMLInputElement).value).toBe("");
  });

  it("folds an OAuth-managed server into the connection card and hides the duplicate row", async () => {
    const notionServer: McpServerConfig = {
      name: "notion",
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer $platform:notion_oauth" },
      enabled: true,
    };
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [notionServer] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({
      providers: [
        {
          id: "notion_oauth",
          label: "Notion",
          description: "Connect to your Notion workspace.",
          mcpUrl: "https://mcp.notion.com/mcp",
          defaultServerName: "notion",
          status: { source: "notion_oauth", connected: true },
        },
      ],
    }));
    fake.install();

    render(<McpServerSettings hasActiveSession={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-oauth-notion_oauth")).toBeInTheDocument();
    });

    // The duplicate standalone row is gone — its Test/Disable controls now
    // live inside the provider card so the user sees one element, not two.
    expect(screen.queryByTestId("mcp-server-notion")).toBeNull();

    const card = screen.getByTestId("mcp-oauth-notion_oauth");
    expect(within(card).getByText(/● Connected/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Test" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("reconciles stale tokens: auth-required status downgrades 'Connected' to Reconnect", async () => {
    // Stored tokens exist (so listMcpOAuthProviders flags Connected) but the
    // MCP server rejected them (CLI init reported needs-auth → "authentication
    // required"). Without reconciliation the user would see two contradictory
    // statuses on the same provider — green "Connected" up top, red "failed —
    // authentication required" down below. The reconciled card shows a single
    // "Authentication required" badge and a Reconnect CTA.
    const linearServer: McpServerConfig = {
      name: "linear",
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer $platform:linear_oauth" },
      enabled: true,
    };
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [linearServer] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({
      providers: [
        {
          id: "linear_oauth",
          label: "Linear",
          description: "Connect to your Linear workspace.",
          mcpUrl: "https://mcp.linear.app/mcp",
          defaultServerName: "linear",
          status: { source: "linear_oauth", connected: true },
        },
      ],
    }));
    fake.install();

    render(<McpServerSettings hasActiveSession={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-oauth-linear_oauth")).toBeInTheDocument();
    });

    // Simulate the worker emitting needs-auth for the managed server.
    useMcpStore.getState().applyStatus("linear", "failed", "authentication required");

    const card = await waitFor(() => screen.getByTestId("mcp-oauth-linear_oauth"));
    await waitFor(() => {
      expect(within(card).getByText(/Authentication required/)).toBeInTheDocument();
    });
    // Green "Connected" is suppressed.
    expect(within(card).queryByText(/● Connected/)).toBeNull();
    // Reconnect is the primary action; Disconnect is still available so the
    // user can opt out instead of refreshing.
    expect(within(card).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    // Test / Enable / Disable are hidden — they'd fail until tokens are fresh.
    expect(within(card).queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("clearStatus drops the stale auth-required entry (used after Reconnect)", () => {
    // White-box: connectProvider() calls clearStatus(defaultServerName) after a
    // successful OAuth round-trip so the card flips back to plain "Connected"
    // immediately instead of waiting for the next CLI init event.
    useMcpStore.getState().applyStatus("linear", "failed", "authentication required");
    expect(useMcpStore.getState().statuses.linear).toBeDefined();

    useMcpStore.getState().clearStatus("linear");
    expect(useMcpStore.getState().statuses.linear).toBeUndefined();

    // Clearing a name that isn't tracked is a no-op (no throw).
    useMcpStore.getState().clearStatus("never-existed");
  });

  it("still shows an orphan OAuth-managed row when the provider is disconnected", async () => {
    // Token revoked at provider side — server config still exists locally,
    // so we surface it in the standalone list (with the via-connection badge)
    // so the user can delete it.
    const notionServer: McpServerConfig = {
      name: "notion",
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer $platform:notion_oauth" },
      enabled: true,
    };
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [notionServer] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({
      providers: [
        {
          id: "notion_oauth",
          label: "Notion",
          description: "Connect to your Notion workspace.",
          mcpUrl: "https://mcp.notion.com/mcp",
          defaultServerName: "notion",
          status: { source: "notion_oauth", connected: false },
        },
      ],
    }));
    fake.install();

    render(<McpServerSettings hasActiveSession={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-notion")).toBeInTheDocument();
    });

    // The row identifies itself as managed by the connection above and
    // hides Edit, but is still visible so the user can delete it.
    const row = screen.getByTestId("mcp-server-notion");
    expect(within(row).getByText(/via Notion connection/)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
