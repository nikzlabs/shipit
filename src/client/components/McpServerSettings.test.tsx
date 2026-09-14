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

    const nameInput = screen.getByPlaceholderText("sentry");
    fireEvent.change(nameInput, { target: { value: "Bad-Name" } });

    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));

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

    fireEvent.change(screen.getByPlaceholderText("sentry"), {
      target: { value: "ok" },
    });
    const commandInput = screen.getByPlaceholderText("npx") as HTMLInputElement;
    fireEvent.change(commandInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Edit linear" }));
    expect(screen.getByText('Edit "linear"')).toBeInTheDocument();

    expect((screen.getByDisplayValue("LINEAR_API_KEY") as HTMLInputElement).value).toBe(
      "LINEAR_API_KEY",
    );
    const valueInputs = screen.getAllByPlaceholderText("(unchanged)");
    expect(valueInputs).toHaveLength(1);
    expect((valueInputs[0] as HTMLInputElement).value).toBe("");
  });

  it("submits a rename with no secrets at all, so the server must carry them (planning#565)", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [stdioConfig] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.on("PUT", /\/api\/mcp-servers\/linear$/, () => ({ server: stdioConfig }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit linear" }));

    fireEvent.change(screen.getByDisplayValue("linear"), { target: { value: "linearprod" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));

    await waitFor(() => {
      expect(fake.calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const put = fake.calls.find((c) => c.method === "PUT")!;
    const body = put.body as {
      config: { env: Record<string, string> };
      secrets: Record<string, string>;
    };
    expect(body.config.env).toEqual({
      LINEAR_API_KEY: "$secret:mcp__linearprod__LINEAR_API_KEY",
    });
    expect(body.secrets).toEqual({});
  });

  it("keeps a reference expression the form cannot represent, moving it on rename", async () => {
    // A header whose value wraps the reference, under a key that is not the
    // secret's name — the shape an agent-written config has.
    const sentry: McpServerConfig = {
      name: "sentry",
      type: "http",
      url: "https://mcp.sentry.dev/mcp",
      headers: { Authorization: "Bearer $secret:mcp__sentry__TOKEN" },
      enabled: true,
    };
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [sentry] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.on("PUT", /\/api\/mcp-servers\/sentry$/, () => ({ server: sentry }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-sentry")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit sentry" }));

    fireEvent.change(screen.getByDisplayValue("sentry"), { target: { value: "sentryprod" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));

    await waitFor(() => {
      expect(fake.calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const body = fake.calls.find((c) => c.method === "PUT")!.body as {
      config: { headers: Record<string, string> };
    };
    expect(body.config.headers).toEqual({
      Authorization: "Bearer $secret:mcp__sentryprod__TOKEN",
    });
  });

  it("writes a typed value to the secret its own row refers to", async () => {
    // Two rows whose keys are not their secrets' names: deriving the target
    // from the key would write this row's value into the other row's secret.
    const aliased: McpServerConfig = {
      name: "linear",
      type: "stdio",
      command: "npx",
      env: {
        API_KEY: "$secret:mcp__linear__TOKEN",
        BACKUP: "$secret:mcp__linear__API_KEY",
      },
      enabled: true,
    };
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [aliased] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.on("PUT", /\/api\/mcp-servers\/linear$/, () => ({ server: aliased }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit linear" }));

    fireEvent.change(screen.getByLabelText("Environment variables — value 1"), {
      target: { value: "rotated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));

    await waitFor(() => {
      expect(fake.calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const body = fake.calls.find((c) => c.method === "PUT")!.body as {
      config: { env: Record<string, string> };
      secrets: Record<string, string>;
    };
    expect(body.secrets).toEqual({ mcp__linear__TOKEN: "rotated" });
    expect(body.config.env).toEqual(aliased.env);
  });

  it("keeps an OAuth $platform: reference through an unrelated edit", async () => {
    const notion: McpServerConfig = {
      name: "notion",
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer $platform:notion_oauth" },
      enabled: true,
    };
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [notion] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.on("PUT", /\/api\/mcp-servers\/notion$/, () => ({ server: notion }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-notion")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit notion" }));

    fireEvent.change(screen.getByDisplayValue("https://mcp.notion.com/mcp"), {
      target: { value: "https://mcp.notion.com/v1/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));

    await waitFor(() => {
      expect(fake.calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const body = fake.calls.find((c) => c.method === "PUT")!.body as {
      config: { headers: Record<string, string> };
    };
    expect(body.config.headers).toEqual({ Authorization: "Bearer $platform:notion_oauth" });
  });

  it("stops claiming a value is unchanged once its key is edited (planning#565)", async () => {
    const fake = new FakeFetch();
    fake.on("GET", /^\/api\/mcp-servers$/, () => ({ servers: [stdioConfig] }));
    fake.on("GET", /\/oauth\/providers$/, () => ({ providers: [] }));
    fake.install();

    render(<McpServerSettings hasActiveSession={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("mcp-server-linear")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit linear" }));

    // A renamed key refers to a secret that was never stored, so "(unchanged)"
    // would promise a value the save cannot carry over.
    fireEvent.change(screen.getByDisplayValue("LINEAR_API_KEY"), {
      target: { value: "LINEAR_TOKEN" },
    });

    expect(screen.queryByPlaceholderText("(unchanged)")).toBeNull();
    expect(screen.getAllByPlaceholderText("value")).toHaveLength(1);
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

    expect(screen.queryByTestId("mcp-server-notion")).toBeNull();

    const card = screen.getByTestId("mcp-oauth-notion_oauth");
    expect(within(card).getByText(/● Connected/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Test" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Disable notion" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Disconnect Notion" })).toBeInTheDocument();
  });

  it("reconciles stale tokens: auth-required status downgrades 'Connected' to Reconnect", async () => {
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

    useMcpStore.getState().applyStatus("notion", "failed", "authentication required");

    const card = await waitFor(() => screen.getByTestId("mcp-oauth-notion_oauth"));
    await waitFor(() => {
      expect(within(card).getByText(/Authentication required/)).toBeInTheDocument();
    });
    expect(within(card).queryByText(/● Connected/)).toBeNull();
    expect(within(card).getByRole("button", { name: "Reconnect Notion" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Disconnect Notion" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("clearStatus drops the stale auth-required entry (used after Reconnect)", () => {
    useMcpStore.getState().applyStatus("notion", "failed", "authentication required");
    expect(useMcpStore.getState().statuses.notion).toBeDefined();

    useMcpStore.getState().clearStatus("notion");
    expect(useMcpStore.getState().statuses.notion).toBeUndefined();

    useMcpStore.getState().clearStatus("never-existed");
  });

  it("still shows an orphan OAuth-managed row when the provider is disconnected", async () => {
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

    const row = screen.getByTestId("mcp-server-notion");
    expect(within(row).getByText(/via Notion connection/)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Edit notion" })).toBeNull();
  });
});
