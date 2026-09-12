

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CredentialRoute } from "../../../server/shared/types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ServicesPanel } from "./ServicesPanel.js";
import { queryServiceMark } from "../service-mark.testing.js";

const route = (over: Partial<CredentialRoute> & Pick<CredentialRoute, "id" | "serviceId" | "billingMode" | "via">): CredentialRoute => ({
  label: over.id,
  isPrimary: false,
  priority: 0,
  status: "ready",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const claudeAgent = {
  id: "claude" as const,
  name: "Claude",
  installed: true,
  hasRunnableModels: false,
  models: [],
  supportsReview: true,
};

const codexAgent = { ...claudeAgent, id: "codex" as const, name: "Codex" };

async function openRowMenu(label: string) {
  await userEvent.click(screen.getByLabelText(`Manage ${label}`));
}

/**
 * Drag one row onto another (req 21), through the HTML5 events the grip uses.
 *
 * jsdom fires no drag sequence of its own and `userEvent` has no drag verb, so
 * the three events the hook listens for are dispatched by hand:
 * `dragstart` on the source's grip, then `dragover` and `drop` on the target
 * row. `dragover` is not decoration — without its `preventDefault` a real
 * browser refuses the drop and never fires `drop` at all, so a test that
 * skipped it would pass over a control that cannot work.
 */
function dragRowOnto(sourceId: string, targetId: string) {
  const dataTransfer = { effectAllowed: "", setData: () => {}, getData: () => sourceId };
  fireEvent.dragStart(screen.getByTestId(`credential-row-${sourceId}-grip`), { dataTransfer });
  const target = screen.getByTestId(`credential-row-${targetId}`);
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

let fetchCalls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  fetchCalls = [];
  useSettingsStore.getState().setCredentialRoutes([]);
  useSettingsStore.getState().setProviderAccounts([]);
  useUiStore.getState().setToast(null);

  useSettingsStore.setState({
    providerAccountNotices: {},
    providerAccountAuths: {},
    providerAccountAuthErrors: {},
    claudeAuthDiagnostics: {},
    claudeAuthOutputOpen: {},
  });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ routes: [] }) });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ServicesPanel", () => {
  it("starts empty — the catalogue lives in the dialog, not on the screen", () => {
    render(<ServicesPanel />);
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();

    expect(screen.queryByText("OpenRouter")).not.toBeInTheDocument();
  });

  it("renders one card per (service, billing mode), not one per credential", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
      route({ id: "cred_3", serviceId: "zai", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("service-card-zai:sub")).toBeInTheDocument();
    expect(screen.getByTestId("service-card-zai:key")).toBeInTheDocument();

    expect(screen.getByTestId("credential-row-cred_1")).toBeInTheDocument();
    expect(screen.getByTestId("credential-row-cred_2")).toBeInTheDocument();
  });

  it("cuts neither a card's name nor a credential's label", () => {

    // draw. Both wrap now; jsdom cannot measure a clip, so the class that would

    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "key", via: "string", label: "GLM (Z.ai) (ZAI_API_KEY)" }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", label: "GLM (Z.ai) (ZAI_CODING_PLAN_KEY)" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("credential-row-cred_1").querySelector(".truncate")).toBeNull();
    expect(screen.getByTestId("credential-row-cred_2").querySelector(".truncate")).toBeNull();
    expect(screen.getByTestId("service-card-zai:key").querySelector("h3")?.className).not.toContain(
      "truncate",
    );
  });

  it("gives no card a way of its own to add a credential (req 17)", () => {

    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string" }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.queryByTestId("service-add-credential-zai:sub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-add-credential-zai:key")).not.toBeInTheDocument();
    expect(screen.getByTestId("services-add")).toBeInTheDocument();
  });

  it("walks service → billing mode → credential, and posts the triple", async () => {
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("services-add-empty"));

    await userEvent.click(screen.getByTestId("add-service-option-zai"));

    expect(screen.getByTestId("add-service-step-mode")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("add-service-mode-key"));

    await userEvent.type(screen.getByTestId("add-service-secret"), "sk-zai");
    await userEvent.click(screen.getByTestId("add-service-save"));

    await waitFor(() => {
      const post = fetchCalls.find((c) => c.url === "/api/credential-routes" && c.method === "POST");
      expect(post?.body).toEqual({ serviceId: "zai", billingMode: "key", secret: "sk-zai" });
    });
  });

  describe("step 1's harness support table", () => {
    it("gives every installed harness a column, and says per service which can run it", async () => {
      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      expect(screen.getByTestId("add-service-support-head-claude")).toHaveTextContent("Claude");
      expect(screen.getByTestId("add-service-support-head-codex")).toHaveTextContent("Codex");

      expect(screen.getByTestId("add-service-support-zai-claude")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-zai-codex")).toHaveAttribute("data-supported", "no");
      expect(screen.getByTestId("add-service-support-openai-claude")).toHaveAttribute("data-supported", "no");
      expect(screen.getByTestId("add-service-support-openai-codex")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-deepseek-claude")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-deepseek-codex")).toHaveAttribute("data-supported", "yes");

      // level too, because the cell is what the user reads before buying a key.
      expect(screen.getByTestId("add-service-support-openrouter-claude")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-openrouter-codex")).toHaveAttribute("data-supported", "yes");
    });

    it("renders the tri-state cell for a harness that runs only part of a service's modes (docs/268)", async () => {
      const opencodeAgent = { ...codexAgent, id: "opencode", name: "OpenCode" };
      render(<ServicesPanel agentList={[claudeAgent, codexAgent, opencodeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      // OpenCode reaches Anthropic's key mode but never its subscription

      // the cell must say "some" — a flat tick would promise a pairing step 2

      const partial = screen.getByTestId("add-service-support-anthropic-opencode");
      expect(partial).toHaveAttribute("data-support", "some");
      expect(partial).toHaveAttribute("data-supported", "yes");

      expect(partial).toHaveTextContent(/API key only/);

      expect(screen.getByTestId("add-service-support-deepseek-opencode")).toHaveAttribute("data-support", "all");
      expect(screen.getByTestId("add-service-support-anthropic-claude")).toHaveAttribute("data-support", "all");
      expect(screen.getByTestId("add-service-support-anthropic-codex")).toHaveAttribute("data-support", "none");
    });

    it("says the answer in words, naming both sides", async () => {

      // because the cells sit in their own column, away from the service names
      // — "runs" alone would answer a question the listener cannot see.
      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      expect(screen.getByTestId("add-service-support-zai-claude")).toHaveTextContent(
        "Claude runs GLM (Z.ai)",
      );
      expect(screen.getByTestId("add-service-support-zai-codex")).toHaveTextContent(
        "Codex cannot run GLM (Z.ai)",
      );
    });

    it("keeps the answers OUT of the row the user presses", async () => {

      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      const row = screen.getByTestId("add-service-option-zai");
      expect(row).not.toHaveTextContent("runs");
      expect(row).toHaveTextContent("GLM (Z.ai)");
      expect(
        within(screen.getByTestId("add-service-support-table")).getByTestId(
          "add-service-support-zai-claude",
        ),
      ).toBeInTheDocument();
    });

    it("never cuts a service name, and keeps each tick in its row's own grid track", async () => {

      // and jsdom cannot measure either — so both are read off the contract

      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      const row = screen.getByTestId("add-service-option-zai");
      expect(row.className).toContain("flex-wrap");
      expect(row.querySelector(".truncate")).toBeNull();
      expect(screen.getByTestId("add-service-support-head-claude").className).not.toContain(
        "truncate",
      );

      // 2. A row that grows keeps its ticks level, because the two containers

      const table = screen.getByTestId("add-service-support-table");
      const list = table.parentElement?.firstElementChild as HTMLElement;
      expect(list.className).toContain("grid-rows-subgrid");
      expect(table.className).toContain("grid-rows-subgrid");

      const rows = screen.getAllByTestId(/^add-service-option-/).length;
      expect(table.parentElement?.style.gridTemplateRows).toBe(`repeat(${rows + 1}, auto)`);

      //    today's names — `min-content` against titles that cannot break. A

      expect(table.parentElement?.style.gridTemplateColumns).toContain("minmax(min-content, 26rem)");
      expect(row.querySelector(".whitespace-nowrap")?.textContent).toBe("GLM (Z.ai)");
    });

    it("carries the same vendor mark the card will carry", async () => {

      // mark is a second way to recognise it, never the only one.
      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      const row = screen.getByTestId("add-service-option-anthropic");

      // 256×256, so this cannot pass on a tick from the support table.
      expect(queryServiceMark(row)).not.toBeNull();
      expect(row).toHaveTextContent("Anthropic");
    });

    it("gives a harness the image does not have no column at all", async () => {
      render(<ServicesPanel agentList={[claudeAgent, { ...codexAgent, installed: false }]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      // A column the user cannot act on is not information — the same filter
      // `InstalledHarnesses` applies, so the two cannot disagree.
      expect(screen.getByTestId("add-service-support-head-claude")).toBeInTheDocument();
      expect(screen.queryByTestId("add-service-support-head-codex")).not.toBeInTheDocument();
      expect(screen.queryByTestId("add-service-support-zai-codex")).not.toBeInTheDocument();
    });

    it("draws no table before the agent list has arrived", async () => {
      render(<ServicesPanel />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      // Nothing known yet must not render as "no harness runs anything".
      expect(screen.queryByTestId("add-service-support-head-claude")).not.toBeInTheDocument();
      expect(screen.getByTestId("add-service-option-zai")).toBeInTheDocument();
    });

    it("still lets an unsupported pairing be chosen", async () => {

      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openrouter"));
      expect(screen.getByTestId("add-service-step-credential")).toBeInTheDocument();
    });
  });

  it("skips the mode step when a service has only one way in", async () => {
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-deepseek"));

    expect(screen.queryByTestId("add-service-step-mode")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-service-step-credential")).toBeInTheDocument();
  });

  describe("choosing the mode starts its sign-in (req 18)", () => {
    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "authenticating",
      createdAt: 1,
      updatedAt: 1,
    };
    const stubAccountApi = (): void => {
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: created, accounts: [created] }) });
      });
    };
    const logins = (): number => fetchCalls.filter((c) => c.url.endsWith("/login")).length;

    it("lands on the provider's code, with nothing to press in between", async () => {

      stubAccountApi();
      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await waitFor(() => expect(logins()).toBe(1));
      useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-openai-1", {
        loginId: "openai-chatgpt",
        accountId: "acct-openai-1",
        verificationUri: "https://auth.openai.com/device",
        userCode: "WXYZ-1234",
      });
      await waitFor(() => expect(
        within(screen.getByTestId("add-service-dialog")).getByTestId("provider-account-user-code-acct-openai-1"),
      ).toHaveTextContent("WXYZ-1234"));
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();
    });

    it("says it is starting, rather than that it stopped, before the code arrives", async () => {

      stubAccountApi();
      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await waitFor(() => expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-signin-stalled")).not.toBeInTheDocument();
    });

    it("says the same between the two requests, where the row is not authenticating yet", async () => {

      const fresh = { ...created, status: "unavailable" };
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        // The login never answers, so the dialog stays in that window.
        if (url.endsWith("/login")) return new Promise(() => {});
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: fresh, accounts: [fresh] }) });
      });

      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await waitFor(() => expect(logins()).toBe(1));
      expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
      expect(screen.queryByTestId("add-service-signin-stalled")).not.toBeInTheDocument();
    });

    it("abandons an account that arrives after the user has left (req 17)", async () => {

      let releaseCreate = (): void => {};
      const createPending = new Promise<void>((resolve) => { releaseCreate = resolve; });
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        const answer = { ok: true, status: 200, json: () => Promise.resolve({ account: created, accounts: [created] }) };
        if (url === "/api/provider-accounts" && init?.method === "POST") {
          return (async () => { await createPending; return answer; })();
        }
        return Promise.resolve(answer);
      });

      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("add-service-dialog")).not.toBeInTheDocument());

      releaseCreate();

      await waitFor(() => expect(fetchCalls.some(
        (c) => c.url === "/api/provider-accounts/codex/acct-openai-1" && c.method === "DELETE",
      )).toBe(true));

      expect(logins()).toBe(0);
      expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument();
    });

    it("offers one button while the sign-in runs itself, and it says Cancel", async () => {

      stubAccountApi();
      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await waitFor(() => expect(logins()).toBe(1));
      const footer = () => within(screen.getByTestId("add-service-dialog"))
        .getAllByRole("button").map((b) => b.textContent);
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();
      expect(footer()).toContain("Cancel");

      useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-openai-1", {
        loginId: "openai-chatgpt", accountId: "acct-openai-1",
        verificationUri: "https://auth.openai.com/device", userCode: "WXYZ-1234",
      });
      await waitFor(() => expect(
        within(screen.getByTestId("add-service-dialog")).getByTestId("provider-account-user-code-acct-openai-1"),
      ).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();
    });

    it("draws the code's own box, at its own size, while it is on its way", async () => {
      stubAccountApi();
      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      const placeholder = await screen.findByTestId("add-service-signin-starting");
      expect(placeholder).toHaveAttribute("aria-busy", "true");

      expect(placeholder.className).toContain("rounded-md border");
    });

    it("shows what the Claude CLI is saying while the wizard runs", async () => {

      const account = {
        id: "acct-anthropic-1",
        serviceId: "anthropic", billingMode: "sub", via: "account",
        label: "Anthropic account 1", isPrimary: true, status: "authenticating",
        createdAt: 1, updatedAt: 1,
      };
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account, accounts: [account] }) });
      });

      render(<ServicesPanel agentList={[claudeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));
      await userEvent.click(screen.getByTestId("add-service-sign-in"));
      await waitFor(() => expect(logins()).toBe(1));

      const placeholder = await screen.findByTestId("add-service-signin-starting");
      expect(placeholder.textContent).toBe("Claude CLI output");

      useSettingsStore.getState().setClaudeAuthProgress("acct-anthropic-1", {
        attemptId: "attempt-1",
        phase: "waiting_for_url",
        message: "Waiting for Claude CLI to print an authentication link.",
      });
      for (const message of ["Launching the Claude CLI.", "Still waiting."]) {
        useSettingsStore.getState().appendClaudeAuthLog("acct-anthropic-1", {
          attemptId: "attempt-1", timestamp: "2026-08-11T00:00:00.000Z",
          level: "info", source: "claude_stdout", message,
        });
      }

      // closed, and inside the panel rather than under it, because the panel is

      const panel = await screen.findByTestId("add-service-signin-starting");
      await waitFor(() => expect(panel)
        .toHaveTextContent("Waiting for Claude CLI to print an authentication link."));
      const buffer = within(panel).getByTestId("provider-account-diagnostics-acct-anthropic-1");
      expect(buffer).toHaveTextContent("Claude CLI output (2)");
      expect(buffer).not.toHaveAttribute("open");

      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-anthropic-1", {
        loginId: "anthropic-oauth", accountId: "acct-anthropic-1",
        verificationUri: "https://claude.ai/oauth/authorize",
      });
      await waitFor(() => expect(
        screen.getByTestId("provider-account-challenge-acct-anthropic-1"),
      ).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-signin-starting")).not.toBeInTheDocument();

      const challenge = screen.getByTestId("provider-account-challenge-acct-anthropic-1");
      expect(within(challenge).getByTestId("provider-account-diagnostics-acct-anthropic-1"))
        .toHaveTextContent("Claude CLI output (2)");
    });

    it("takes the sign-in button away with the click, not a moment after", async () => {

      let releaseCreate = (): void => {};
      const createPending = new Promise<void>((resolve) => { releaseCreate = resolve; });
      const claudeAccount = {
        id: "acct-anthropic-3",
        serviceId: "anthropic", billingMode: "sub", via: "account",
        label: "Anthropic account 3", isPrimary: true, status: "authenticating",
        createdAt: 1, updatedAt: 1,
      };
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        const answer = { ok: true, status: 200, json: () => Promise.resolve({ account: claudeAccount, accounts: [claudeAccount] }) };
        if (url === "/api/provider-accounts" && init?.method === "POST") {
          return (async () => { await createPending; return answer; })();
        }
        return Promise.resolve(answer);
      });

      render(<ServicesPanel agentList={[claudeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await userEvent.click(screen.getByTestId("add-service-sign-in"));

      expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();

      expect(screen.getByTestId("provider-account-diagnostics-pending")).toBeInTheDocument();

      releaseCreate();
      await waitFor(() => expect(logins()).toBe(1));
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();
    });

    it("keeps the output open across the moment the code arrives", async () => {

      const account = {
        id: "acct-anthropic-2",
        serviceId: "anthropic", billingMode: "sub", via: "account",
        label: "Anthropic account 2", isPrimary: true, status: "authenticating",
        createdAt: 1, updatedAt: 1,
      };
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account, accounts: [account] }) });
      });

      render(<ServicesPanel agentList={[claudeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));
      await userEvent.click(screen.getByTestId("add-service-sign-in"));
      await waitFor(() => expect(logins()).toBe(1));
      useSettingsStore.getState().appendClaudeAuthLog("acct-anthropic-2", {
        attemptId: "attempt-2", timestamp: "2026-08-12T00:00:00.000Z",
        level: "info", source: "shipit", message: "Spawned claude /login.",
      });

      const buffer = await screen.findByTestId("provider-account-diagnostics-acct-anthropic-2");
      await userEvent.click(within(buffer).getByText(/Claude CLI output/));
      expect(screen.getByTestId("provider-account-diagnostics-acct-anthropic-2")).toHaveAttribute("open");

      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-anthropic-2", {
        loginId: "anthropic-oauth", accountId: "acct-anthropic-2",
        verificationUri: "https://claude.ai/oauth/authorize",
      });

      await waitFor(() => expect(
        screen.getByTestId("provider-account-challenge-acct-anthropic-2"),
      ).toBeInTheDocument());

      expect(screen.getByTestId("provider-account-diagnostics-acct-anthropic-2")).toHaveAttribute("open");
    });

    it("leaves a mode that also takes a key alone — there the sign-in is a choice", async () => {

      render(<ServicesPanel agentList={[claudeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      expect(screen.getByTestId("add-service-secret")).toBeInTheDocument();
      expect(screen.getByTestId("add-service-sign-in")).toBeInTheDocument();
      expect(logins()).toBe(0);
    });

    it("takes the token field away while the sign-in has a field of its own", async () => {

      // string, and pasting the code there saves a credential that cannot work.

      const account = {
        id: "acct-anthropic-1",
        serviceId: "anthropic", billingMode: "sub", via: "account",
        label: "Anthropic account 1", isPrimary: true, status: "authenticating",
        createdAt: 1, updatedAt: 1,
      };
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account, accounts: [account] }) });
      });

      render(<ServicesPanel agentList={[claudeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));
      expect(screen.getByTestId("add-service-secret")).toBeInTheDocument();

      // Save either — the button cannot outlive the field it acts on.
      await userEvent.click(screen.getByTestId("add-service-sign-in"));
      await waitFor(() => expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-secret")).not.toBeInTheDocument();
      expect(screen.queryByTestId("add-service-save")).not.toBeInTheDocument();

      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-anthropic-1", {
        loginId: "anthropic-oauth", accountId: "acct-anthropic-1",
        verificationUri: "https://claude.ai/oauth/authorize",
      });
      await waitFor(() => expect(
        screen.getByTestId("provider-account-challenge-acct-anthropic-1"),
      ).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-secret")).not.toBeInTheDocument();

      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-anthropic-1", null);
      useSettingsStore.getState().setProviderAccountAuthError(
        "anthropic-oauth", "acct-anthropic-1", "That code was refused.",
      );
      await waitFor(() => expect(screen.getByTestId("add-service-secret")).toBeInTheDocument());
      expect(screen.getByTestId("add-service-save")).toBeInTheDocument();
    });

    it("starts nothing that would fail on arrival, and says why", async () => {
      // A harness that cannot run the login: the step stays as it was, with the

      stubAccountApi();
      render(<ServicesPanel agentList={[{ ...codexAgent, installed: false }]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      expect(screen.getByTestId("add-service-harness-missing")).toBeInTheDocument();
      expect(logins()).toBe(0);
      expect(fetchCalls.some((c) => c.url === "/api/provider-accounts" && c.method === "POST")).toBe(false);
    });

    it("starts nothing while another sign-in of the provider is in flight", async () => {

      stubAccountApi();
      useSettingsStore.getState().setProviderAccounts([
        route({ id: "acct-openai-9", serviceId: "openai", billingMode: "sub", via: "account", status: "authenticating", externalId: "ext-9", label: "OpenAI account 9" }),
      ]);
      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      expect(screen.getByTestId("add-service-signin-blocked")).toBeInTheDocument();
      expect(logins()).toBe(0);
    });
  });

  it("shows Save with the field it saves, and not a step early", async () => {

    // in the browser, the button never becomes enabled; it just looks like a

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    expect(screen.queryByTestId("add-service-save")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    expect(screen.queryByTestId("add-service-save")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-save")).toBeInTheDocument();
  });

  it("signs in inside the dialog for a mode connected only by signing in (req 17)", async () => {

    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "authenticating",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ accounts: [created] }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-account-only")).toBeInTheDocument();

    expect(screen.queryByTestId("add-service-secret")).not.toBeInTheDocument();

    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts" && c.method === "POST",
    )).toBe(true));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login" && c.method === "POST",
    )).toBe(true));

    useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-openai-1", {
      loginId: "openai-chatgpt",
      accountId: "acct-openai-1",
      verificationUri: "https://auth.openai.com/device",
      userCode: "WXYZ-1234",
    });
    await waitFor(() => {
      const dialog = within(screen.getByTestId("add-service-dialog"));
      expect(dialog.getByTestId("provider-account-challenge-acct-openai-1")).toBeInTheDocument();
      expect(dialog.getByTestId("provider-account-user-code-acct-openai-1")).toHaveTextContent("WXYZ-1234");
    });

    expect(screen.getAllByTestId("provider-account-challenge-acct-openai-1")).toHaveLength(1);
  });

  it("keeps the attempt abandonable when the login fails to START (req 17)", async () => {

    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "unavailable",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/login")) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "codex CLI is not installed" }) });
      }
      const accounts = init?.method === "DELETE" ? [] : [created];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: created, accounts }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));

    await waitFor(() => expect(screen.getByTestId("add-service-error")).toHaveTextContent("codex CLI is not installed"));
    expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again");

    await userEvent.click(within(screen.getByTestId("add-service-dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1" && c.method === "DELETE",
    )).toBe(true));
  });

  it("retries on the same account rather than creating a second one (req 17)", async () => {
    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "unavailable",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/login")) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "spawn failed" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: created, accounts: [created] }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again"));
    await userEvent.click(screen.getByTestId("add-service-sign-in"));

    await waitFor(() => expect(fetchCalls.filter(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login",
    ).length).toBe(2));

    expect(fetchCalls.filter((c) => c.url === "/api/provider-accounts" && c.method === "POST").length).toBe(1);
  });

  it("offers a retry when the provider REJECTS a live challenge (req 17)", async () => {

    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "authenticating",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: created, accounts: [created] }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));

    useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-openai-1", {
      loginId: "openai-chatgpt",
      accountId: "acct-openai-1",
      verificationUri: "https://auth.openai.com/device",
      userCode: "WXYZ-1234",
    });
    await waitFor(() => expect(
      within(screen.getByTestId("add-service-dialog")).getByTestId("provider-account-challenge-acct-openai-1"),
    ).toBeInTheDocument());

    useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-openai-1", null);
    useSettingsStore.getState().setProviderAccountAuthError("openai-chatgpt", "acct-openai-1", "That code expired.");

    await waitFor(() => expect(screen.getByTestId("add-service-signin-stalled")).toHaveTextContent("That code expired."));
    expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again");
  });

  it("abandons the account when the sign-in is cancelled, leaving nothing listed (req 17)", async () => {
    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "authenticating",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      const accounts = init?.method === "DELETE" ? [] : [created];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ accounts }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(fetchCalls.some((c) => c.url === "/api/provider-accounts")).toBe(true));

    await userEvent.click(within(screen.getByTestId("add-service-dialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login/cancel",
    )).toBe(true));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1" && c.method === "DELETE",
    )).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument());
  });

  it("closing the dialog mid-challenge abandons the attempt too (req 17)", async () => {

    const created = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "authenticating",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      const accounts = init?.method === "DELETE" ? [] : [created];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: created, accounts }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts" && c.method === "POST",
    )).toBe(true));

    expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("add-service-dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login/cancel",
    )).toBe(true));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1" && c.method === "DELETE",
    )).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument());
  });

  it("closing after the account connected keeps it (req 17)", async () => {

    const connected = {
      id: "acct-openai-1",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account 1",
      isPrimary: true,
      status: "ready",
      externalId: "ext-openai-1",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ account: connected, accounts: [connected] }) });
    });

    render(<ServicesPanel agentList={[codexAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-openai"));

    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(screen.getByTestId("add-service-signed-in")).toBeInTheDocument());

    // flicker: it is a credential now, so it appears once and stays. What must
    // never appear is a card for an attempt, which is a different question

    expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("add-service-dialog")).not.toBeInTheDocument());
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();
  });

  it("offers BOTH a sign-in and a token for a mode that accepts both", async () => {

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-secret")).toBeInTheDocument();
    expect(screen.getByTestId("add-service-sign-in")).toBeInTheDocument();
  });

  it("titles step 3 for the account path and makes signing in the primary button (D4)", async () => {

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));

    const step = screen.getByTestId("add-service-step-credential");
    expect(step).toHaveTextContent("3 · Sign in");
    expect(step).not.toHaveTextContent("3 · Paste the key");
    expect(screen.getByTestId("add-service-string-alternative")).toHaveTextContent("Or paste a token");

    const dialog = screen.getByTestId("add-service-dialog");
    const buttons = within(dialog).getAllByRole("button");
    const save = screen.getByTestId("add-service-save");
    const signIn = screen.getByTestId("add-service-sign-in");
    expect(buttons.indexOf(signIn)).toBeGreaterThan(buttons.indexOf(save));
    expect(signIn.className).toContain("bg-(--color-accent)");
    expect(save.className).not.toContain("bg-(--color-accent)");
  });

  it("hands the emphasis to Save once a token is in the field", async () => {

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await userEvent.type(screen.getByTestId("add-service-secret"), "sk-ant-oat01-x");

    expect(screen.getByTestId("add-service-save").className).toContain("bg-(--color-accent)");
    expect(screen.getByTestId("add-service-sign-in").className).not.toContain("bg-(--color-accent)");

    // Emptying the field puts the recommendation back, so the sign-in is never

    await userEvent.clear(screen.getByTestId("add-service-secret"));
    expect(screen.getByTestId("add-service-sign-in").className).toContain("bg-(--color-accent)");
    expect(screen.getByTestId("add-service-save").className).not.toContain("bg-(--color-accent)");
  });

  it("keeps step 3 titled for the key when the mode takes nothing else", async () => {
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-deepseek"));

    const step = screen.getByTestId("add-service-step-credential");
    expect(step).toHaveTextContent("3 · Paste the key");

    expect(screen.queryByTestId("add-service-string-alternative")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-service-save").className).toContain("bg-(--color-accent)");
  });

  it("reorders a subscription's credentials, which changes which one is delivered", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel />);
    dragRowOnto("cred_2", "cred_1");
    await waitFor(() => {
      const put = fetchCalls.find((c) => c.method === "PUT");
      expect(put?.url).toBe("/api/credential-routes/zai/sub/order");
      expect(put?.body).toEqual({ routeIds: ["cred_2", "cred_1"] });
    });
  });

  it("offers the selection mode on a subscription holding several credentials", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("credential-selection-mode-zai:sub-balanced"));
    await waitFor(() => {
      const put = fetchCalls.find((c) => c.url === "/api/settings");
      expect(put?.body).toEqual({ accountSelectionMode: { "zai:sub": "balanced" } });
    });
  });

  it("offers no selection mode on an API-key card, nor on a lone credential", () => {
    // req 12 rendered: keys do not fail over, so there is nothing to order and

    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.queryByTestId("credential-selection-mode-deepseek:key")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credential-selection-mode-zai:sub")).not.toBeInTheDocument();
  });

  it("offers no ordering where a mode holds one credential", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.queryByTestId("credential-row-cred_1-grip")).not.toBeInTheDocument();
  });

  it("removes a credential through the route endpoint", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await openRowMenu("cred_1");
    await userEvent.click(screen.getByTestId("credential-remove-cred_1"));
    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: "/api/credential-routes/cred_1",
        method: "DELETE",
        body: undefined,
      });
    });
  });

  it("replaces a secret without changing the route", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await openRowMenu("cred_1");
    await userEvent.click(screen.getByTestId("credential-replace-cred_1"));
    await userEvent.type(screen.getByTestId("credential-replace-input-cred_1"), "sk-new");
    await userEvent.click(screen.getByTestId("credential-replace-submit-cred_1"));
    await waitFor(() => {
      const patch = fetchCalls.find((c) => c.method === "PATCH");
      expect(patch?.url).toBe("/api/credential-routes/cred_1");
      expect(patch?.body).toEqual({ secret: "sk-new" });
    });
  });

  it("renders an account-backed subscription through the accounts card, with no key disclosure", () => {
    const now = Date.now();
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);
    expect(screen.getByTestId("provider-account-rows-claude")).toBeInTheDocument();

    // accounts card must not offer a second editor for it.
    expect(screen.queryByTestId("provider-toggle-api-key-claude")).not.toBeInTheDocument();
  });
});

describe("ServicesPanel — one card component (docs/252 D2, D7, D8, D9)", () => {
  const now = Date.now();
  const anthropicAccount = (id: string, isPrimary = false): CredentialRoute => ({
    id, serviceId: "anthropic", billingMode: "sub", via: "account",
    label: id, isPrimary, status: "ready", createdAt: now, updatedAt: now,
  });

  it("puts the account rows inside the service's card, not beside the list", () => {
    useSettingsStore.getState().setProviderAccounts([anthropicAccount("acct_1", true)]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    const card = screen.getByTestId("service-card-anthropic:sub");
    expect(within(card).getByTestId("provider-account-rows-claude")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Anthropic" })).toBeInTheDocument();

    const avatar = within(card).getByTestId("service-avatar-anthropic");
    expect(avatar.querySelector("svg")).not.toBeNull();
    expect(avatar).toHaveTextContent("");
    // The harness vendor never titles a credential card.
    expect(screen.queryByText(/Claude subscriptions/i)).not.toBeInTheDocument();
  });

  it("counts the credentials of a mode across both delivery shapes", () => {
    useSettingsStore.getState().setProviderAccounts([
      anthropicAccount("acct_1", true),
      anthropicAccount("acct_2"),
    ]);

    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_env", serviceId: "anthropic", billingMode: "sub", via: "string" }),
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    const card = screen.getByTestId("service-card-anthropic:sub");

    expect(within(card).getByTestId("service-count-pill-service-card-anthropic:sub"))
      .toHaveTextContent("3 credentials");
    expect(screen.getAllByTestId(/^service-card-anthropic:sub$/)).toHaveLength(1);
  });

  /**
   * The two delivery shapes of ONE mode are not one routing pool, and the card
   * must not imply they are.
   *
   * `selectAccountForTurn` answers for the accounts, and phase 5 decided an
   * `all_exhausted` account walk is returned unchanged rather than falling
   * through to the mode's env-delivered token (`service-routing.ts`). Two
   * consequences, both pinned here: the routing band counts and names only the
   * accounts, and the env token gets no order controls — the reorder endpoint
   * demands every route of the `(service, mode)` exactly once, so a list of
   * just the string ids is a 400. Found by cross-backend review.
   */
  it("does not present an env token and the accounts as one routing pool", () => {
    useSettingsStore.getState().setProviderAccounts([anthropicAccount("acct_1", true)]);
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_env_a", serviceId: "anthropic", billingMode: "sub", via: "string" }),
      route({ id: "cred_env_b", serviceId: "anthropic", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.queryByTestId("service-routing-service-card-anthropic:sub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credential-selection-mode-anthropic:sub")).not.toBeInTheDocument();
    // No ordering on the tokens: the endpoint would reject a list that omits

    expect(screen.queryByTestId("credential-row-cred_env_a-grip")).not.toBeInTheDocument();
    /**
     * docs/252 req 19/20 — and the card says NOTHING about the token being
     * environment-supplied, because the sentence it used to print was false:
     * the panel rendered it for every `via: "string"` row on an account-backed
     * card, and those rows are ordinary stored credentials with no recorded
     * provenance. Req 20 also removes the distinction it was reaching for — a
     * deployment-supplied credential is adopted into an ordinary row at boot.
     * Its true half (reqs 12/13) is what the two assertions above pin.
     */
    expect(screen.queryByTestId("service-string-fallback-anthropic:sub")).not.toBeInTheDocument();
  });

  it("gives the routing controls their own band, not an inline block", () => {
    useSettingsStore.getState().setProviderAccounts([
      anthropicAccount("acct_1", true),
      anthropicAccount("acct_2"),
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    const band = screen.getByTestId("service-routing-service-card-anthropic:sub");
    expect(within(band).getByRole("radiogroup", { name: "How ShipIt picks between these accounts" }))
      .toBeInTheDocument();
    expect(within(band).getByTestId("credential-selection-mode-anthropic:sub")).toBeInTheDocument();
    expect(within(band).getByTestId("failover-cutoffs-anthropic:sub")).toBeInTheDocument();
  });

  it("offers the order AND the cutoffs on a string-delivered subscription that reports quota", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel />);

    const band = screen.getByTestId("service-routing-service-card-zai:sub");
    expect(within(band).getByRole("radiogroup", { name: "How ShipIt picks between these credentials" }))
      .toBeInTheDocument();
    expect(within(band).getByTestId("credential-selection-mode-zai:sub")).toBeInTheDocument();
    expect(within(band).getByTestId("failover-cutoffs-zai:sub")).toBeInTheDocument();
  });

  it("says nothing about routing on a lone subscription, or on a key card", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", isPrimary: true }),
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);

    expect(screen.getByTestId("service-card-zai:sub")).toBeInTheDocument();
    expect(screen.queryByTestId("service-routing-service-card-zai:sub")).not.toBeInTheDocument();

    expect(screen.queryByTestId("service-routing-service-card-deepseek:key")).not.toBeInTheDocument();
  });

  it("says nothing about routing on a subscription with no credential yet", () => {

    useSettingsStore.getState().setProviderAccountNotice("anthropic-oauth", {
      kind: "info", message: "Disconnected.",
    });
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.getByTestId("service-card-anthropic:sub")).toBeInTheDocument();
    expect(screen.queryByTestId("service-routing-service-card-anthropic:sub")).not.toBeInTheDocument();
  });
});

describe("ServicesPanel credential-row errors (docs/257 req 5)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "nope" }),
      }),
    );
  });

  it("reports a failed removal on the row, not as a toast", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await openRowMenu("cred_1");
    await userEvent.click(screen.getByTestId("credential-remove-cred_1"));
    await waitFor(() => {
      expect(screen.getByTestId("credential-error-cred_1")).toBeInTheDocument();
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("reports a failed replacement on the row", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    await openRowMenu("cred_1");
    await userEvent.click(screen.getByTestId("credential-replace-cred_1"));
    await userEvent.type(screen.getByTestId("credential-replace-input-cred_1"), "sk-new");
    await userEvent.click(screen.getByTestId("credential-replace-submit-cred_1"));
    await waitFor(() => {
      expect(screen.getByTestId("credential-error-cred_1")).toBeInTheDocument();
    });
    expect(useUiStore.getState().toast).toBeNull();
  });
});

describe("ServicesPanel keeps a card that has something to say (docs/257 req 5)", () => {
  const now = Date.now();
  const seedOneClaudeAccount = () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
  };

  it("drops the card silently when the LAST account disconnects — nothing left to say (docs/260-turn-level-account-routing req 3)", async () => {
    seedOneClaudeAccount();

    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ accounts: [] }),
      }),
    );

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-disconnect-acct_1"));

    // because there is no moved/stranded story to tell (req 3).
    await waitFor(() => {
      expect(screen.queryByTestId("provider-account-rows-claude")).toBeNull();
    });
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-accounts-notice-claude")).toBeNull();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("keeps the card and lands the busy-process refusal on the row (docs/260-turn-level-account-routing req 13)", async () => {
    seedOneClaudeAccount();

    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: "An agent is still working on this account. Wait for it to finish." }),
      }),
    );

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-disconnect-acct_1"));

    await waitFor(() => {
      expect(screen.getByTestId("provider-account-notice-acct_1"))
        .toHaveTextContent("Wait for it to finish");
    });
    expect(screen.getByTestId("provider-account-row-acct_1")).toBeInTheDocument();
    expect(screen.getByTestId("provider-account-rows-claude")).toBeInTheDocument();
    expect(useUiStore.getState().toast).toBeNull();
  });

  describe("attempts are not credentials (req 17)", () => {

    // never added. The rule is derived from the account, not tracked beside it,

    const account = (over: Partial<CredentialRoute>): CredentialRoute => ({
      id: "acct-1",
      serviceId: "openai",
      billingMode: "sub",
      via: "account",
      label: "OpenAI account",
      isPrimary: true,
      status: "ready",
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });

    it("does not list a row that has never been anything but an attempt", () => {
      for (const status of ["unavailable", "authenticating"] as const) {
        useSettingsStore.getState().setProviderAccounts([account({ status })]);
        const view = render(<ServicesPanel agentList={[codexAgent]} />);
        expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument();
        view.unmount();
      }
    });

    it("lists a connected row that reported no identity", () => {

      useSettingsStore.getState().setProviderAccounts([account({ status: "ready" })]);
      render(<ServicesPanel agentList={[codexAgent]} />);
      expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();
    });

    it("lists a row that was signed out after connecting", () => {

      // connected row back to `unavailable`, and that row must stay reachable

      useSettingsStore.getState().setProviderAccounts([
        account({ status: "unavailable", externalId: "ext-1" }),
      ]);
      render(<ServicesPanel agentList={[codexAgent]} />);
      expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();
    });

    it("adopts a stranded attempt instead of creating a second one", async () => {

      useSettingsStore.getState().setProviderAccounts([
        account({ id: "acct-stranded", status: "authenticating" }),
      ]);
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ accounts: [] }) });
      });

      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await waitFor(() => expect(fetchCalls.some(
        (c) => c.url === "/api/provider-accounts/codex/acct-stranded/login" && c.method === "POST",
      )).toBe(true));
      expect(fetchCalls.some((c) => c.url === "/api/provider-accounts" && c.method === "POST")).toBe(false);
      expect(fetchCalls.some(
        (c) => c.url === "/api/provider-accounts/codex/acct-stranded/login/cancel",
      )).toBe(true);
    });
  });

  describe("installed harnesses", () => {

    it("names what can drive the credentials, and says which cannot run yet", () => {
      render(
        <ServicesPanel agentList={[{ ...claudeAgent, hasRunnableModels: true }, codexAgent]} />,
      );
      const block = within(screen.getByTestId("installed-harnesses"));
      expect(block.getByTestId("installed-harness-claude")).toHaveTextContent("Claude");
      expect(block.getByTestId("installed-harness-claude")).not.toHaveTextContent("no model");
      expect(block.getByTestId("installed-harness-codex")).toHaveTextContent("no model it can run yet");
    });

    it("lists only installed harnesses, and says so when none is", () => {
      render(<ServicesPanel agentList={[{ ...codexAgent, installed: false }]} />);
      expect(screen.queryByTestId("installed-harness-codex")).toBeNull();
      expect(screen.getByTestId("installed-harnesses")).toHaveTextContent(/None\./);
    });

    it("says nothing at all before the agent list has arrived", () => {

      render(<ServicesPanel />);
      expect(screen.queryByTestId("installed-harnesses")).toBeNull();
    });
  });

  it("drops the card again once the notice is dismissed", async () => {
    useSettingsStore.getState().setProviderAccounts([]);
    useSettingsStore.getState().setProviderAccountNotice("anthropic-oauth", { kind: "info", message: "Disconnected." });
    render(<ServicesPanel agentList={[claudeAgent]} />);
    expect(screen.getByTestId("provider-account-rows-claude")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("provider-accounts-notice-claude-dismiss"));

    // message, not because anything is configured.
    expect(screen.queryByTestId("provider-account-rows-claude")).toBeNull();
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
  });
});

/**
 * docs/252 req 19 — **reconnect is the add-service dialog, entered differently.**
 *
 * Two things this pins, and both are constraints rather than behaviours,
 * because the whole point of the change is that no second surface appears. The
 * row used to post `/login` itself and render `AccountChallenge` inline — and
 * that component returns `null` until the auth URL arrives, so between the
 * click and the URL the row showed nothing at all. Rebuilding a poorer copy of
 * step 3 anywhere is the failure mode; these are what make it a red build.
 */
describe("reconnect goes through the one dialog (docs/252 req 19)", () => {
  const now = Date.now();
  const seedConnected = () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
      route({ id: "acct_2", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", externalId: "ext-1", createdAt: now, updatedAt: now },
      { id: "acct_2", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal", isPrimary: false, status: "ready", externalId: "ext-2", createdAt: now, updatedAt: now },
    ]);
  };

  it("mounts exactly one add-service dialog, however it was opened", async () => {
    seedConnected();
    render(<ServicesPanel agentList={[claudeAgent]} />);
    expect(screen.queryAllByTestId("add-service-dialog")).toHaveLength(0);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    expect(screen.queryAllByTestId("add-service-dialog")).toHaveLength(1);

    expect(screen.getByTestId("add-service-step-credential")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-step-service")).toBeNull();
    expect(screen.queryByTestId("add-service-step-mode")).toBeNull();
  });

  /**
   * docs/252 req 19, found by cross-backend review: `isUnconnectedAttempt` is
   * NOT sufficient on its own to decide whether cancel may delete.
   *
   * A login whose identity cannot be read **proceeds** by design
   * (`provider-account-identity.ts`), so a genuinely connected account can have
   * no `externalId` — and starting a reconnect moves it to `authenticating`,
   * the predicate's other clause. Both true, on a working credential, and the
   * first cut deleted it. Only the dialog can answer the real question, which
   * is whether it MINTED the id (`mintedHere`).
   */
  it("keeps a connected account that never reported an identity, mid-reconnect", async () => {
    const now = Date.now();
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);

    const unidentified = { id: "acct_1", serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const, label: "Work", isPrimary: true, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([{ ...unidentified, status: "ready" as const }]);

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    act(() => {
      useSettingsStore.getState().setProviderAccounts([{ ...unidentified, status: "authenticating" as const }]);
    });
    await userEvent.click(screen.getByText("Cancel"));

    expect(fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(fetchCalls.some((c) => c.url.endsWith("/login/cancel"))).toBe(true);
  });

  it("opens a reconnect on the waiting panel, never on the stalled one", async () => {
    seedConnected();
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-signin-stalled")).toBeNull();

    expect(screen.getByTestId("add-service-title")).toHaveTextContent("Reconnect — Anthropic · Work");
  });

  it("does not show a failed attempt's reason over a reconnect that is running", async () => {
    seedConnected();

    useSettingsStore.getState().setProviderAccountAuthError(
      "anthropic-oauth", "acct_1", "Your Anthropic session expired.",
    );
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    act(() => {
      useSettingsStore.getState().setProviderAccounts([
        { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "authenticating", externalId: "ext-1", createdAt: now, updatedAt: now },
      ]);
    });

    expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-signin-stalled")).toBeNull();

    expect(screen.queryByTestId("add-service-sign-in")).toBeNull();
  });

  it("does not judge the attempt by the status the last one left", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", createdAt: now, updatedAt: now }),
    ]);
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "auth_failed", externalId: "ext-1", createdAt: now, updatedAt: now },
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-signin-stalled")).toBeNull();
    expect(screen.queryByTestId("add-service-sign-in")).toBeNull();
  });

  /**
   * The other half of the same rule, and what stops the fix above from being a
   * dialog that can never say a sign-in failed: a failure arriving *during* the
   * attempt is this attempt's, and it must land on the stalled panel with its
   * *Try again* — which then re-arms the whole guard for the retry.
   */
  it("still reaches Try again when the attempt itself fails, and hides it again on the retry", async () => {
    seedConnected();
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));
    act(() => {
      useSettingsStore.getState().setProviderAccounts([
        { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "authenticating", externalId: "ext-1", createdAt: now, updatedAt: now },
      ]);
    });

    act(() => {
      useSettingsStore.getState().setProviderAccounts([
        { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "auth_failed", externalId: "ext-1", createdAt: now, updatedAt: now },
      ]);
      useSettingsStore.getState().setProviderAccountAuthError(
        "anthropic-oauth", "acct_1", "The authorization code expired.",
      );
    });
    expect(screen.getByTestId("add-service-signin-stalled")).toHaveTextContent("The authorization code expired.");

    await userEvent.click(screen.getByTestId("add-service-sign-in"));
    expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-signin-stalled")).toBeNull();
    expect(screen.queryByTestId("add-service-sign-in")).toBeNull();
  });

  /**
   * **A reconnect that never started is not a reconnect that succeeded.**
   *
   * The provider runs one login at a time, so pressing *Reconnect* while another
   * account is signing in makes the `POST …/login` a refusal. The row is
   * untouched by that — still `ready`, because the old credential is still
   * there — and the catch then set `reconnectLeftReady`, which is the other half
   * of `signedIn`. So the dialog answered a refused request with the flow's
   * SUCCESS screen: "Connected. Anthropic subscription is ready — its models are
   * selectable now." over a *Done* button, with the refusal in small text
   * underneath. Nothing on it offered another try.
   *
   * The old credential really is still usable, which is what makes the wrong
   * screen plausible enough to ship. It is still the wrong one: the user asked
   * to re-authenticate, that did not happen, and the way back has to be on
   * screen.
   */
  it("reports a refused reconnect as failed, not as connected", async () => {
    seedConnected();

    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      const refused = (init?.method ?? "GET") === "POST" && url.endsWith("/login");
      return Promise.resolve({
        ok: !refused,
        status: refused ? 409 : 200,
        json: () => Promise.resolve(
          refused ? { error: 'Claude is already signing in on "Personal". Finish or cancel that sign-in first.' } : { routes: [] },
        ),
      });
    });

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    expect(screen.getByTestId("add-service-signin-stalled")).toBeInTheDocument();
    expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again");
    expect(screen.queryByTestId("add-service-signed-in")).toBeNull();
    expect(screen.queryByTestId("add-service-done")).toBeNull();

    expect(screen.getByTestId("add-service-error")).toHaveTextContent("already signing in");
  });

  /**
   * The other half of the case above, and the one that must not regress while
   * fixing it: a refused *start* changes nothing about the credential. It was
   * connected before the press and it is connected after — the dialog reports a
   * failed attempt, it does not revoke anything.
   */
  it("leaves the credential connected when the reconnect is refused", async () => {
    seedConnected();
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      const refused = (init?.method ?? "GET") === "POST" && url.endsWith("/login");
      return Promise.resolve({
        ok: !refused,
        status: refused ? 409 : 200,
        json: () => Promise.resolve(refused ? { error: "Busy." } : { routes: [] }),
      });
    });

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));
    await userEvent.click(screen.getByText("Cancel"));

    const rows = screen.getAllByTestId(/^provider-account-row-acct_\d+$/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "provider-account-row-acct_1",
      "provider-account-row-acct_2",
    ]);
    expect(fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  /**
   * The one thing that could go badly wrong. `AddServiceDialog` abandons the
   * attempt IT created; a connected account is not an attempt
   * (`isUnconnectedAttempt` is false once it has an `externalId`), so cancelling
   * a reconnect must leave it connected and exactly where it was in the order.
   * Deleting the user's working credential because they changed their mind
   * about re-authenticating would be the worst bug this feature could ship.
   */
  it("leaves the account connected and in position when the reconnect is cancelled", async () => {
    seedConnected();
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));
    await userEvent.click(screen.getByText("Cancel"));

    expect(screen.queryAllByTestId("add-service-dialog")).toHaveLength(0);

    const rows = screen.getAllByTestId(/^provider-account-row-acct_\d+$/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "provider-account-row-acct_1",
      "provider-account-row-acct_2",
    ]);
    expect(fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
  });
});

describe("the compact service card (docs/252 req 19)", () => {
  it("drops the per-card description prose", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    const card = screen.getByTestId("service-card-deepseek:key");

    expect(card).not.toHaveTextContent(/Metered — no quota to report/);
    expect(card).not.toHaveTextContent(/ShipIt fails over between them/);
  });

  it("moves the model ids into a corner control rather than a chip row", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    const control = screen.getByTestId("service-models-service-card-deepseek:key");

    expect(control).toHaveTextContent(/^\d+ models?$/);

    await userEvent.click(control);
    expect(await screen.findByTestId("supported-models-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("supported-models-service-deepseek")).toBeInTheDocument();
  });

  it("opens the same dialog from the heading, with no service configured", async () => {

    // cross-backend review). Asserted on an EMPTY panel, because the whole point

    render(<ServicesPanel />);
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("services-supported-models"));
    expect(await screen.findByTestId("supported-models-dialog")).toBeInTheDocument();

    expect(screen.getByTestId("supported-models-service-openrouter")).toBeInTheDocument();
  });
});

/**
 * docs/272 req 6 — the one standing hazard the panel says in words.
 *
 * OpenCode Go's caps are real and ShipIt can read none of them: the service
 * publishes no per-key usage API, so the card carries no remaining figure, and
 * the console's "Use balance" option turns cap exhaustion into metered Zen
 * spend server-side with nothing on the wire for ShipIt to notice. A number
 * cannot say that and a failure never arrives, so the sentence is the only
 * surface left.
 */
describe("the OpenCode Go billing hazard (docs/272 req 6)", () => {
  it("says it on the card that holds the Go credential", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_go", serviceId: "opencode", billingMode: "sub", via: "string" }),
    ]);
    render(<ServicesPanel />);
    const notice = screen.getByTestId("mode-notice-opencode:sub");
    expect(notice).toHaveTextContent(/no per-key quota API/);
    expect(notice).toHaveTextContent(/Use balance/);
  });

  it("says nothing on the metered Zen card, which has no such hazard", () => {
    // The map is closed on purpose: req 19 deleted per-card prose because it

    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_zen", serviceId: "opencode", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("service-card-opencode:key")).toBeInTheDocument();
    expect(screen.queryByTestId("mode-notice-opencode:key")).not.toBeInTheDocument();
  });

  it("says it before the key is pasted, while the mode can still be refused", async () => {
    render(<ServicesPanel />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-opencode"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(await screen.findByTestId("mode-notice-opencode:sub")).toBeInTheDocument();
  });
});

describe("the xAI subscription's weekly pool (planning#454)", () => {
  it("prints no absence notice on the subscription card, because there is a reader", () => {
    useSettingsStore.getState().setProviderAccounts([
      route({ id: "acct_xai", serviceId: "xai", billingMode: "sub", via: "account", label: "nik@x" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("service-card-xai:sub")).toBeInTheDocument();
    expect(screen.queryByTestId("mode-notice-xai:sub")).not.toBeInTheDocument();
  });

  it("says nothing on the metered xAI key card, which promises no allowance", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_xai", serviceId: "xai", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    expect(screen.getByTestId("service-card-xai:key")).toBeInTheDocument();
    expect(screen.queryByTestId("mode-notice-xai:key")).not.toBeInTheDocument();
  });

  it("shows the weekly figure on the account row, and no empty short window", () => {
    useSettingsStore.getState().setProviderAccounts([
      route({ id: "acct_xai", serviceId: "xai", billingMode: "sub", via: "account", label: "nik@x" }),
    ]);
    useUiStore.getState().setSubscriptionLimits({
      "xai:sub": {
        acct_xai: {

          serviceId: "xai", billingMode: "sub", routeId: "acct_xai", plan: null,
          session: null,
          weekly: { usedPct: 10, resetAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },

          availableWindows: ["weekly"],
          fetchedAt: Date.now(),
        },
      },
    });
    render(<ServicesPanel />);
    const row = screen.getByTestId("provider-account-row-acct_xai");
    expect(row).toHaveTextContent("nik@x");
    expect(row).toHaveTextContent(/7d\s*10%/);
    expect(row.textContent).not.toMatch(/5h/);
  });
});

/**
 * docs/252 req 20's consequence for the panel: **"both shapes" means both
 * PRESENT, not both possible.**
 *
 * `mixedDelivery` read "this mode can take an account, and holds a string",
 * which is a different question, and adoption turned the difference into a
 * visible defect. Anthropic's subscription CAN take an account; a deployment
 * with none and two supplied credentials has a real routing pool of two — and
 * reading the empty account list as the pool left the card offering no order
 * between them and no band at all. It was unreachable before adoption, because
 * the second string credential was invisible.
 */
describe("an account-capable mode holding only supplied credentials (docs/252 req 20)", () => {
  const twoStrings = () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "anthropic", billingMode: "sub", via: "string", priority: 0, isPrimary: true, label: "Mine" }),
      route({ id: "claude-env-oauth", serviceId: "anthropic", billingMode: "sub", via: "string", priority: 1, label: "From the deployment" }),
    ]);
  };

  it("routes between them, naming them credentials rather than accounts", () => {
    twoStrings();
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.getByTestId("service-count-pill-service-card-anthropic:sub"))
      .toHaveTextContent("2 credentials");
    const band = screen.getByTestId("service-routing-service-card-anthropic:sub");
    expect(within(band).getByRole("radiogroup", { name: "How ShipIt picks between these credentials" }))
      .toBeInTheDocument();
    /**
     * **And the cutoffs, because Anthropic reports a quota.** This asserted
     * their ABSENCE, on the belief that only account-backed subscriptions
     * report one. They do not: a snapshot is recorded per route and gated only
     * on the mode being a subscription, so a plan token supplied as a string
     * reports its 5h and 7d windows exactly as an account does — and the
     * string-delivered walk now applies the cutoffs to it. Two credentials, an
     * order and a strategy with no thresholds beside them was the bug.
     */
    expect(within(band).getByTestId("failover-cutoffs-anthropic:sub")).toBeInTheDocument();
  });

  it("offers the cutoffs and a read-out for a supplied subscription that reports quota", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", priority: 0, isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    useUiStore.getState().setSubscriptionLimits({
      "zai:sub": {
        cred_1: {
          serviceId: "zai", billingMode: "sub", routeId: "cred_1", plan: null,
          session: { usedPct: 44, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
          weekly: null, fetchedAt: Date.now(),
        },
      },
    });
    render(<ServicesPanel />);

    const band = screen.getByTestId("service-routing-service-card-zai:sub");
    expect(within(band).getByTestId("credential-selection-mode-zai:sub")).toBeInTheDocument();
    expect(within(band).getByTestId("failover-cutoffs-zai:sub")).toBeInTheDocument();
    expect(screen.getByTestId("credential-row-cred_1").textContent).toMatch(/5h/);
  });

  it("shows each supplied credential's own quota, as the header always has", () => {
    twoStrings();
    useUiStore.getState().setSubscriptionLimits({
      "anthropic:sub": {
        cred_1: {
          routeId: "cred_1", serviceId: "anthropic", fetchedAt: Date.now(),
          session: { usedPct: 42, resetAt: new Date(Date.now() + 3_600_000).toISOString(), source: "usage-api" },
          weekly: null,
        },
      },
    } as never);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.getByTestId("credential-row-cred_1")).toHaveTextContent("5h 42%");
  });

  it("lets them be reordered, which is what decides the one delivered", async () => {
    twoStrings();
    render(<ServicesPanel agentList={[claudeAgent]} />);

    dragRowOnto("claude-env-oauth", "cred_1");

    await waitFor(() => {
      const put = fetchCalls.find((c) => c.method === "PUT");
      expect(put?.url).toBe("/api/credential-routes/anthropic/sub/order");
      expect(put?.body).toEqual({ routeIds: ["claude-env-oauth", "cred_1"] });
    });
  });

  it("still refuses to order the strings once an account is present too", () => {
    twoStrings();
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", externalId: "ext-1", createdAt: now, updatedAt: now },
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.queryByTestId("credential-row-cred_1-grip")).not.toBeInTheDocument();

    expect(screen.queryByTestId("service-routing-service-card-anthropic:sub")).not.toBeInTheDocument();
  });
});
