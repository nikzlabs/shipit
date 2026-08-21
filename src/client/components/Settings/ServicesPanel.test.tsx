/**
 * docs/252 phase 2 — Settings → Services.
 *
 * The behaviours worth pinning are the ones that come from the requirements
 * rather than from the layout: the screen lists what you configured (not the
 * catalogue), the add-flow makes the billing mode an explicit choice (req 5),
 * and a key card carries no routing controls (req 12).
 */

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

/**
 * Open a credential row's `⋯` (docs/252 req 19).
 *
 * Every per-credential verb — Rename, Replace secret / Reconnect, Remove /
 * Disconnect — moved in there, so the tests that used to click a
 * permanently-rendered button open the menu first. That extra line IS the
 * compaction: a 39px row holding two controls became a 28px row holding none
 * until asked.
 */
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
  // Auth state is keyed by (provider, account id), and these tests reuse ids —
  // a live challenge left by one case makes the next one's account look
  // mid-sign-in rather than stalled.
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
    // Nothing from the catalogue is listed until the user asks for it.
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
    // Two credentials, one card.
    expect(screen.getByTestId("credential-row-cred_1")).toBeInTheDocument();
    expect(screen.getByTestId("credential-row-cred_2")).toBeInTheDocument();
  });

  it("cuts neither a card's name nor a credential's label", () => {
    // Two labels for one service differ only at their END — an ellipsis there
    // leaves two rows reading identically, which is what a narrow panel used to
    // draw. Both wrap now; jsdom cannot measure a clip, so the class that would
    // cause one is what is pinned.
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
    // This asserted the opposite until req 17: "Add another" on a multi-
    // credential card, "Add account" on an account-backed one. Both are gone,
    // and the rule is now uniform across card types rather than per-type — one
    // door, on the panel.
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
    // GLM has both modes, so the mode step is a real choice (req 5).
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
      // The cell is the catalogue's answer, asked before any credential exists:
      // GLM speaks Anthropic Messages and reaches only Claude Code, OpenAI
      // speaks Responses and reaches only Codex, DeepSeek serves both.
      expect(screen.getByTestId("add-service-support-zai-claude")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-zai-codex")).toHaveAttribute("data-supported", "no");
      expect(screen.getByTestId("add-service-support-openai-claude")).toHaveAttribute("data-supported", "no");
      expect(screen.getByTestId("add-service-support-openai-codex")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-deepseek-claude")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-deepseek-codex")).toHaveAttribute("data-supported", "yes");
      // A gateway ticks EXISTENTIALLY, over its models: OpenRouter's Codex tick
      // is carried by its two DeepSeek rows (2026-08-15, planning#391) while its
      // Anthropic and GLM rows speak Anthropic Messages only. Pinned at the UI
      // level too, because the cell is what the user reads before buying a key.
      expect(screen.getByTestId("add-service-support-openrouter-claude")).toHaveAttribute("data-supported", "yes");
      expect(screen.getByTestId("add-service-support-openrouter-codex")).toHaveAttribute("data-supported", "yes");
    });

    it("renders the tri-state cell for a harness that runs only part of a service's modes (docs/268)", async () => {
      const opencodeAgent = { ...codexAgent, id: "opencode", name: "OpenCode" };
      render(<ServicesPanel agentList={[claudeAgent, codexAgent, opencodeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      // OpenCode reaches Anthropic's key mode but never its subscription
      // (no account target; the env-OAuth token is carrier-restricted), so
      // the cell must say "some" — a flat tick would promise a pairing step 2
      // then refuses, the collapse catalogue.test.ts forbids.
      const partial = screen.getByTestId("add-service-support-anthropic-opencode");
      expect(partial).toHaveAttribute("data-support", "some");
      expect(partial).toHaveAttribute("data-supported", "yes");
      // And the spoken answer names the modes that DO work.
      expect(partial).toHaveTextContent(/API key only/);
      // Full and none keep their plain answers.
      expect(screen.getByTestId("add-service-support-deepseek-opencode")).toHaveAttribute("data-support", "all");
      expect(screen.getByTestId("add-service-support-anthropic-claude")).toHaveAttribute("data-support", "all");
      expect(screen.getByTestId("add-service-support-anthropic-codex")).toHaveAttribute("data-support", "none");
    });

    it("says the answer in words, naming both sides", async () => {
      // `data-supported` alone would keep passing if the tick and the spoken
      // answer both vanished. Each cell names the harness AND the service
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
      // The shape the human asked for, and the one this got wrong first time:
      // the service rows stay as they were and the table is a separate thing
      // beside them. A row that swallowed the cells again would pass every
      // assertion above, so this is the one that pins the layout.
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
      // What this pins is the pair of decisions that survive a narrow window,
      // and jsdom cannot measure either — so both are read off the contract
      // that produces them.
      //
      // The window that provoked this was 484px wide with four harnesses
      // installed: the table took 5.5rem a column first, the list was the only
      // thing allowed to shrink, and the row the user presses ended up with a
      // name clipped to nothing and its mode label spilling out of the button.
      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      // 1. No name is drawn with an ellipsis. `truncate` anywhere inside the
      //    row is exactly the clipping this replaced; the name wraps instead.
      const row = screen.getByTestId("add-service-option-zai");
      expect(row.className).toContain("flex-wrap");
      expect(row.querySelector(".truncate")).toBeNull();
      expect(screen.getByTestId("add-service-support-head-claude").className).not.toContain(
        "truncate",
      );

      // 2. A row that grows keeps its ticks level, because the two containers
      //    are subgrids over ONE set of row tracks rather than two stacks of
      //    matching heights. The old arrangement went out of line the first
      //    time anything wrapped.
      const table = screen.getByTestId("add-service-support-table");
      const list = table.parentElement?.firstElementChild as HTMLElement;
      expect(list.className).toContain("grid-rows-subgrid");
      expect(table.className).toContain("grid-rows-subgrid");
      // One track per service, plus the head — read off the rows actually
      // drawn, so adding a service to the catalogue does not fail this.
      const rows = screen.getAllByTestId(/^add-service-option-/).length;
      expect(table.parentElement?.style.gridTemplateRows).toBe(`repeat(${rows + 1}, auto)`);

      // 3. The column's floor is the widest name, not a number measured against
      //    today's names — `min-content` against titles that cannot break. A
      //    literal here would start cutting the first title that outgrew it.
      expect(table.parentElement?.style.gridTemplateColumns).toContain("minmax(min-content, 26rem)");
      expect(row.querySelector(".whitespace-nowrap")?.textContent).toBe("GLM (Z.ai)");
    });

    it("carries the same vendor mark the card will carry", async () => {
      // The row the user picks and the card they come back to are the same
      // service, so they show the same thing. The row keeps its name too — the
      // mark is a second way to recognise it, never the only one.
      render(<ServicesPanel agentList={[claudeAgent, codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));

      const row = screen.getByTestId("add-service-option-anthropic");
      // The mark's 24×24 grid rather than any `svg` — Phosphor's glyphs are
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
      // The tick is a fact, not a gate: harnesses arrive with images, and
      // refusing the row would make ShipIt the obstacle (req 1).
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
    // A one-option choice is not a choice.
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
      // OpenAI's subscription is account-only, so step 3 was one button over
      // one sentence: a click that asked nothing and could be answered one way.
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
      // The code arrives on a broadcast after the login starts. That gap read
      // as "the sign-in stopped before the account connected" — a flash behind
      // a button press before, and the landing screen now.
      stubAccountApi();
      render(<ServicesPanel agentList={[codexAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-openai"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      await waitFor(() => expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-signin-stalled")).not.toBeInTheDocument();
    });

    it("says the same between the two requests, where the row is not authenticating yet", async () => {
      // The row is created BEFORE the login is asked for, and it is created
      // `unavailable` — so between the two requests it is neither
      // authenticating nor failed. Measured live, that was a 35 ms flash of
      // "the sign-in stopped" on the way to the code.
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
      // `cancel` can only abandon an id it has, and the create had not returned
      // one yet — so leaving during that window closed the dialog over an
      // account that appeared behind the user: hidden from the panel, holding
      // the provider's login slot, with nothing on screen to release it. The
      // sign-in starting on the mode click is what makes the window easy to
      // hit. Found by the independent review.
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
      // Out before the account exists.
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("add-service-dialog")).not.toBeInTheDocument());

      releaseCreate();

      await waitFor(() => expect(fetchCalls.some(
        (c) => c.url === "/api/provider-accounts/codex/acct-openai-1" && c.method === "DELETE",
      )).toBe(true));
      // And no login was started on it on the way out.
      expect(logins()).toBe(0);
      expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument();
    });

    it("offers one button while the sign-in runs itself, and it says Cancel", async () => {
      // A second button beside a box the user is watching fill in is a live
      // control they did not ask for, in the one place where an accidental
      // click restarts the login they are in the middle of. The retry it
      // carried is traded for closing and starting again — the same recovery
      // everything else in this dialog uses.
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
      // The same shell as the challenge, so nothing moves when the code lands.
      expect(placeholder.className).toContain("rounded-md border");
    });

    it("shows what the Claude CLI is saying while the wizard runs", async () => {
      // Anthropic's sign-in is a wizard ShipIt drives, not a code handed over,
      // so the wait before the paste field can run for a while — and a pulse
      // alone reads as stuck rather than as working. What the CLI is saying
      // goes IN the box the field will occupy: everything transient about the
      // sign-in in one panel, and the full buffer stays one collapsed control
      // rather than a second live copy of the same lines.
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

      // Nothing known yet: the box is the shape of the one Anthropic shows — a
      // field to paste into, not a code to read — and the only thing in it is
      // the buffer control, reserved so its arrival does not grow the panel a
      // few frames after the panel itself appeared.
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

      // Inside the box: the phase where the link will be, and the buffer —
      // closed, and inside the panel rather than under it, because the panel is
      // the whole of the sign-in. Two rejected cuts are why that is asserted:
      // a live three-line tail beside it showed the same output twice, and the
      // control under the box made the sign-in two places to look.
      const panel = await screen.findByTestId("add-service-signin-starting");
      await waitFor(() => expect(panel)
        .toHaveTextContent("Waiting for Claude CLI to print an authentication link."));
      const buffer = within(panel).getByTestId("provider-account-diagnostics-acct-anthropic-1");
      expect(buffer).toHaveTextContent("Claude CLI output (2)");
      expect(buffer).not.toHaveAttribute("open");

      // The box becomes the real thing, and the buffer is there to open.
      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-anthropic-1", {
        loginId: "anthropic-oauth", accountId: "acct-anthropic-1",
        verificationUri: "https://claude.ai/oauth/authorize",
      });
      await waitFor(() => expect(
        screen.getByTestId("provider-account-challenge-acct-anthropic-1"),
      ).toBeInTheDocument());
      expect(screen.queryByTestId("add-service-signin-starting")).not.toBeInTheDocument();
      // Still one, still closed, still in the panel — it does not move house
      // when the field arrives.
      const challenge = screen.getByTestId("provider-account-challenge-acct-anthropic-1");
      expect(within(challenge).getByTestId("provider-account-diagnostics-acct-anthropic-1"))
        .toHaveTextContent("Claude CLI output (2)");
    });

    it("takes the sign-in button away with the click, not a moment after", async () => {
      // The click turns the panel above into the waiting box at once. The
      // button used to stay through the create request — one frame of blue,
      // then seven of nothing — which reads as a control that hung around
      // after the UI had moved on and was then swapped for a disabled Save.
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
      // Anthropic's subscription takes a key too, so this one is pressed.
      await userEvent.click(screen.getByTestId("add-service-sign-in"));

      // Still inside the create request: the panel is already the waiting box,
      // and the button is already gone.
      expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();
      // And the buffer control is already in it, before there is an account to
      // key it by — appearing later grew the panel a second time, a few frames
      // after it had appeared.
      expect(screen.getByTestId("provider-account-diagnostics-pending")).toBeInTheDocument();

      releaseCreate();
      await waitFor(() => expect(logins()).toBe(1));
      expect(screen.queryByTestId("add-service-sign-in")).not.toBeInTheDocument();
    });

    it("keeps the output open across the moment the code arrives", async () => {
      // The disclosure is rendered by the waiting panel and then by the
      // challenge — two components, so the element is destroyed and rebuilt at
      // exactly the moment the user is reading it. Uncontrolled, it came back
      // closed and the panel jumped by the height of what they were reading.
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
      // Still open, in the rebuilt one.
      expect(screen.getByTestId("provider-account-diagnostics-acct-anthropic-2")).toHaveAttribute("open");
    });

    it("leaves a mode that also takes a key alone — there the sign-in is a choice", async () => {
      // Anthropic's subscription accepts an env-supplied token too, so step 3
      // has a field. Starting a login nobody asked for would pre-empt it.
      render(<ServicesPanel agentList={[claudeAgent]} />);
      await userEvent.click(screen.getByTestId("services-add-empty"));
      await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
      await userEvent.click(screen.getByTestId("add-service-mode-sub"));

      expect(screen.getByTestId("add-service-secret")).toBeInTheDocument();
      expect(screen.getByTestId("add-service-sign-in")).toBeInTheDocument();
      expect(logins()).toBe(0);
    });

    it("takes the token field away while the sign-in has a field of its own", async () => {
      // Anthropic's sign-in ends at "Paste authorization code". The token field
      // one gap below it is a second place to paste, it takes a different
      // string, and pasting the code there saves a credential that cannot work.
      // So the challenge is the only input while the login runs — and the token
      // comes back when the attempt stops, which is when a fallback is useful.
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

      // The wait, then the challenge: no token field through either, and no
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

      // The provider rejects it — the failure event clears the challenge and
      // files the reason — so there is one input again, and it is the token's.
      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-anthropic-1", null);
      useSettingsStore.getState().setProviderAccountAuthError(
        "anthropic-oauth", "acct-anthropic-1", "That code was refused.",
      );
      await waitFor(() => expect(screen.getByTestId("add-service-secret")).toBeInTheDocument());
      expect(screen.getByTestId("add-service-save")).toBeInTheDocument();
    });

    it("starts nothing that would fail on arrival, and says why", async () => {
      // A harness that cannot run the login: the step stays as it was, with the
      // reason on it, rather than auto-starting into an error.
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
      // docs/150 — one login per provider, so the server would refuse a second.
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
    // It used to render from step 1, where there is nothing to save: disabled
    // the whole time, and — the mode being unknown — `primary`, so arriving at
    // a mode with an account path ANIMATED it blue-to-grey. Sampled per frame
    // in the browser, the button never becomes enabled; it just looks like a
    // control that was available and was then taken away.
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    expect(screen.queryByTestId("add-service-save")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    expect(screen.queryByTestId("add-service-save")).not.toBeInTheDocument();

    // Step 3, and this mode takes a key: now there is something to save.
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-save")).toBeInTheDocument();
  });

  it("signs in inside the dialog for a mode connected only by signing in (req 17)", async () => {
    // The hand-off is gone. It sent the user out of a flow they had started —
    // "press Add account on its card" — and paid for it with a revealed empty
    // card the user could not then remove.
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
    // OpenAI's subscription takes no supplied secret, so there is no input.
    expect(screen.queryByTestId("add-service-secret")).not.toBeInTheDocument();

    // One act: the account is created and its login started.
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts" && c.method === "POST",
    )).toBe(true));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login" && c.method === "POST",
    )).toBe(true));

    // And the challenge renders HERE — the same component the row renders,
    // inside the dialog the user is already in.
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
    // ONCE. The account exists the moment the sign-in starts, so its card is
    // rendered behind the modal — and the card's rows host the same shared
    // challenge, which put the provider's code on screen twice (and two
    // paste-code inputs on Anthropic, of which only one submits). The rows
    // stand down for the account the dialog is hosting, and only that one:
    // a challenge nothing else is showing — after a reload, or started in
    // another tab — still belongs to the row (`Settings.test.tsx` pins that).
    expect(screen.getAllByTestId("provider-account-challenge-acct-openai-1")).toHaveLength(1);
  });

  it("keeps the attempt abandonable when the login fails to START (req 17)", async () => {
    // The account exists from the moment the create call returns; the login is
    // a second request. Awaiting both before learning the id left a failed
    // start un-abandonable — Cancel had nothing to delete, and each retry
    // created another orphan. Cross-backend review found it.
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
    // The mode click starts the sign-in (req 18) — no second press.
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));

    // The failure is stated in the dialog, with a way forward...
    await waitFor(() => expect(screen.getByTestId("add-service-error")).toHaveTextContent("codex CLI is not installed"));
    expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again");

    // ...and Cancel can still take the orphan away, which is the whole point.
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
    // The mode click starts the sign-in (req 18) — no second press.
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again"));
    await userEvent.click(screen.getByTestId("add-service-sign-in"));

    await waitFor(() => expect(fetchCalls.filter(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login",
    ).length).toBe(2));
    // One account, two login attempts — not two accounts.
    expect(fetchCalls.filter((c) => c.url === "/api/provider-accounts" && c.method === "POST").length).toBe(1);
  });

  it("offers a retry when the provider REJECTS a live challenge (req 17)", async () => {
    // `agent_auth_failed` clears the challenge and files the reason under
    // `providerAccountAuthErrors`. The dialog did not read that, so it rendered
    // an empty step with Sign in already hidden — the hand-off req 17 removes,
    // rebuilt on the error path.
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
    // The mode click starts the sign-in (req 18) — no second press.
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

    // What the failure event does: clear the challenge, file the reason.
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
    // The mode click starts the sign-in (req 18) — no second press.
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(fetchCalls.some((c) => c.url === "/api/provider-accounts")).toBe(true));

    await userEvent.click(within(screen.getByTestId("add-service-dialog")).getByRole("button", { name: "Cancel" }));

    // Cancel means what it says: the login is called off AND the account it
    // created goes, so an abandoned attempt leaves no service listed. This is
    // the exact state the old reveal left behind and could not undo.
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1/login/cancel",
    )).toBe(true));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts/codex/acct-openai-1" && c.method === "DELETE",
    )).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("service-card-openai:sub")).not.toBeInTheDocument());
  });

  it("closing the dialog mid-challenge abandons the attempt too (req 17)", async () => {
    // Every way out is the same way out. An earlier cut kept a dismissed
    // attempt alive on the card, reasoning that the provider may already have
    // authorised the code — rejected against req 17: "unless you pressed
    // Escape" is not a clause anybody would predict, and one press to start
    // again is cheaper than a service listed that nobody asked for.
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
    // The mode click starts the sign-in (req 18) — no second press.
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(fetchCalls.some(
      (c) => c.url === "/api/provider-accounts" && c.method === "POST",
    )).toBe(true));
    // The panel behind the dialog does not move: the account exists server-side
    // from this moment, but it is the dialog's until the flow ends. A card that
    // appears here is one the user then watches disappear on Escape.
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
    // The guard that makes "closing means cancelling" safe: it abandons an
    // UNFINISHED attempt. A connected account is the thing the flow set out to
    // create, so Done and Esc are the same harmless exit.
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
    // The mode click starts the sign-in (req 18) — no second press.
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await waitFor(() => expect(screen.getByTestId("add-service-signed-in")).toBeInTheDocument());
    // The card appears the moment the account connects, and that is not a
    // flicker: it is a credential now, so it appears once and stays. What must
    // never appear is a card for an attempt, which is a different question
    // about the same row (`isUnconnectedAttempt`).
    expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("add-service-dialog")).not.toBeInTheDocument());
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();
  });

  it("offers BOTH a sign-in and a token for a mode that accepts both", async () => {
    // Anthropic's subscription takes an OAuth account and an env-supplied
    // token. Treating "takes an account" as "takes nothing else" would hide the
    // input; the reverse left signing in unreachable from this dialog.
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    expect(screen.getByTestId("add-service-secret")).toBeInTheDocument();
    expect(screen.getByTestId("add-service-sign-in")).toBeInTheDocument();
  });

  it("titles step 3 for the account path and makes signing in the primary button (D4)", async () => {
    // The step used to be titled by whichever shape existed rather than by the
    // one being recommended: "3 · Paste the key" sat above prose saying the
    // service is connected by signing in, with *Save* primary. The token stays
    // reachable — it genuinely works — under its own sub-heading.
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));

    const step = screen.getByTestId("add-service-step-credential");
    expect(step).toHaveTextContent("3 · Sign in");
    expect(step).not.toHaveTextContent("3 · Paste the key");
    expect(screen.getByTestId("add-service-string-alternative")).toHaveTextContent("Or paste a token");

    // The DOM order of the two buttons is the visual ranking, and the variants
    // say which one is being recommended.
    const dialog = screen.getByTestId("add-service-dialog");
    const buttons = within(dialog).getAllByRole("button");
    const save = screen.getByTestId("add-service-save");
    const signIn = screen.getByTestId("add-service-sign-in");
    expect(buttons.indexOf(signIn)).toBeGreaterThan(buttons.indexOf(save));
    expect(signIn.className).toContain("bg-(--color-accent)");
    expect(save.className).not.toContain("bg-(--color-accent)");
  });

  it("hands the emphasis to Save once a token is in the field", async () => {
    // The recommendation holds only until the user answers it. With a token
    // typed in, the blue button used to still say "Sign in to Anthropic" — and
    // pressing it did the other thing, replacing the step with the CLI wizard.
    // Demoted, not removed: signing in is still a working way in from here.
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await userEvent.type(screen.getByTestId("add-service-secret"), "sk-ant-oat01-x");

    expect(screen.getByTestId("add-service-save").className).toContain("bg-(--color-accent)");
    expect(screen.getByTestId("add-service-sign-in").className).not.toContain("bg-(--color-accent)");

    // Emptying the field puts the recommendation back, so the sign-in is never
    // stranded behind a stray character.
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
    // No competing path, so no "Or …" sub-heading and no demoted Save.
    expect(screen.queryByTestId("add-service-string-alternative")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-service-save").className).toContain("bg-(--color-accent)");
  });

  // docs/252 req 21 — the carets became one drag grip per row. What is being
  // pinned is unchanged and is not cosmetic: the FIRST credential of a group is
  // the one delivered, so moving a row changes which key sessions receive.
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

  // docs/252 phase 5 — phase 2 stored this setting per `(service, mode)` with no
  // control able to reach it, and it did nothing until failover was real.
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
    // nothing to spread — and with one credential there is nowhere to go.
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
    // The Anthropic key is its own `(anthropic, key)` card here, so the
    // accounts card must not offer a second editor for it.
    expect(screen.queryByTestId("provider-toggle-api-key-claude")).not.toBeInTheDocument();
  });
});

/**
 * docs/252 — **one** card component, whatever way the credential arrives.
 *
 * The account-backed body used to be a card of its own rendered OUTSIDE this
 * list: borderless, titled after the harness vendor, with its own header and
 * its own routing controls. These pin the properties that make the two bodies
 * one card rather than two that merely sit near each other.
 */
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
    // The vendor's mark, not the service's initial — the avatar is the one
    // thing on the row that can be recognised without reading.
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
    // The same mode also holds an env-supplied token — one card, one count.
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_env", serviceId: "anthropic", billingMode: "sub", via: "string" }),
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    const card = screen.getByTestId("service-card-anthropic:sub");
    // "credentials", not "accounts": the env token is on this card and is not
    // an account. Three rows, three counted.
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

    // One account in the pool, so there is nothing to route between — even
    // though the card holds three credentials — and a band with nothing to say
    // is absent, not explanatory.
    expect(screen.queryByTestId("service-routing-service-card-anthropic:sub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credential-selection-mode-anthropic:sub")).not.toBeInTheDocument();
    // No ordering on the tokens: the endpoint would reject a list that omits
    // the account, and they are not in the accounts' failover chain anyway.
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

  /**
   * docs/252 req 19 — the band is still its own band, and still holds both
   * controls; what went is the uppercase TITLE printed above them. The string
   * survives as the segmented control's accessible name, which is asserted
   * where the control lives (`CredentialRouting.test.tsx`) along with the three
   * tooltips carrying the rest of the copy.
   */
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

  /**
   * D14 / planning#339 — a cutoff follows the QUOTA, not the delivery shape.
   *
   * GLM's coding plan is the case that proves it: a subscription with no login
   * flow, authenticated by a pasted key, on a service that is not first-party.
   * It had the order and no cutoffs for as long as `zai-plan-usage` was a
   * declared id with no reader behind it, and gained them — with no change to
   * this panel — the moment planning#339 built one.
   */
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

  /**
   * A single credential and a key are the SAME absence, and the panel treats
   * them the same way. The lone subscription briefly carried "One credential —
   * nothing to route between yet. Add a second to choose an order and a
   * strategy."; it was rejected on sight in the dogfood instance for the reason
   * req 12 already gives for the key card — a sentence explaining an absence,
   * printed once per single-credential service on every visit to Settings.
   */
  it("says nothing about routing on a lone subscription, or on a key card", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", isPrimary: true }),
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);

    expect(screen.getByTestId("service-card-zai:sub")).toBeInTheDocument();
    expect(screen.queryByTestId("service-routing-service-card-zai:sub")).not.toBeInTheDocument();
    // req 12: a key card gets no band at all — not a disabled group, not an
    // empty section, and no sentence explaining the absence.
    expect(screen.queryByTestId("service-routing-service-card-deepseek:key")).not.toBeInTheDocument();
  });

  it("says nothing about routing on a subscription with no credential yet", () => {
    // req 17 leaves exactly one way for a card to be on screen with no
    // credential: a notice holding it open after the last account went.
    useSettingsStore.getState().setProviderAccountNotice("anthropic-oauth", {
      kind: "info", message: "Disconnected.",
    });
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.getByTestId("service-card-anthropic:sub")).toBeInTheDocument();
    expect(screen.queryByTestId("service-routing-service-card-anthropic:sub")).not.toBeInTheDocument();
  });
});

/**
 * docs/257 req 5 — a credential row reports its own failures, inline.
 *
 * Reachable during onboarding and not only after it: between docs/252 phases 2
 * and 3 a user can add a DeepSeek key from the onboarding panel and get a card
 * whose `canRunTurns` stays false, so these rows exist while the panel is still
 * on screen and a toast fired from inside it would land somewhere else.
 */
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

/**
 * docs/257 req 5 — a card with something to say stays mounted (the clause is
 * `notices[provider]` in the `configured` filter, since the card's presence is
 * otherwise derived from the account list). docs/260-turn-level-account-routing req 3 narrowed what a
 * disconnect has to say: a SUCCESSFUL disconnect reports nothing — no moved or
 * stranded sessions, no replacement to pick — so the last account's removal
 * legitimately drops the card. The notices that still keep it mounted arrive
 * from elsewhere (the duplicate-account refusal, failed setting saves); the
 * one refusal a disconnect can still hit (req 13, busy process) leaves the
 * row in place to carry its own message.
 */
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
    // The server just disconnects: `{accounts}` only, no session bookkeeping.
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

    // Back to "only what you configured": no notice keeps the card mounted,
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
    // The one refusal disconnect still makes: a live process is running a turn
    // or holding background work on this account. The account survives, so the
    // message is row-scoped and the card stays for the account, not a notice.
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
    // The flicker this removed: the account row exists from the instant a
    // sign-in starts and is deleted again if the user backs out, so anything
    // listing credentials gained a card and lost it around a service that was
    // never added. The rule is derived from the account, not tracked beside it,
    // which is why there is no window where the two disagree.
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
      // `externalId` alone would over-hide: an unreadable identity PROCEEDS by
      // design (`provider-account-identity.ts:118`), so a working account can
      // have none. Hiding a credential the user is using would be far worse
      // than showing an attempt.
      useSettingsStore.getState().setProviderAccounts([account({ status: "ready" })]);
      render(<ServicesPanel agentList={[codexAgent]} />);
      expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();
    });

    it("lists a row that was signed out after connecting", () => {
      // And the status alone would over-hide too: `signOutAccount` puts a
      // connected row back to `unavailable`, and that row must stay reachable
      // to reconnect or remove.
      useSettingsStore.getState().setProviderAccounts([
        account({ status: "unavailable", externalId: "ext-1" }),
      ]);
      render(<ServicesPanel agentList={[codexAgent]} />);
      expect(screen.getByTestId("service-card-openai:sub")).toBeInTheDocument();
    });

    it("adopts a stranded attempt instead of creating a second one", async () => {
      // What makes hiding safe: an attempt nobody is conducting — stranded by a
      // reload — is invisible AND holds the provider's single login slot. The
      // next sign-in picks it up, so it ends as a credential or a deletion
      // rather than blocking every future attempt from behind the scenes.
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

      // No second account, and the stale login is cleared before the new one
      // starts so the challenge shown is the live one rather than a 409.
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
    // The other half of "can this install run a turn": docs/252 req 8's
    // eligibility is a join, so a stored credential is only runnable when an
    // installed harness can carry it. A user with a working key and a disabled
    // composer has to be able to see which half is missing.
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
      // "Not known yet" and "none installed" are different facts, and the
      // bootstrap delivers the list after the first render.
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
    // Back to "only what you configured" — the card was on screen to deliver a
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

    // One dialog — not a `ReconnectDialog` beside it, and not a second copy of
    // step 3 rendered into the row.
    expect(screen.queryAllByTestId("add-service-dialog")).toHaveLength(1);
    // And it opens ON step 3, service and mode already chosen: reconnect knows
    // both, so making the user pick them again would be a flow, not a shortcut.
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
    // Connected and listed, but with NO `externalId` — an identity that could
    // not be read, which the login proceeds past by design.
    const unidentified = { id: "acct_1", serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const, label: "Work", isPrimary: true, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([{ ...unidentified, status: "ready" as const }]);

    render(<ServicesPanel agentList={[claudeAgent]} />);
    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    // The server's broadcast lands: the row is now `authenticating` with no
    // identity — both of `isUnconnectedAttempt`'s clauses, on a credential the
    // user has been using.
    act(() => {
      useSettingsStore.getState().setProviderAccounts([{ ...unidentified, status: "authenticating" as const }]);
    });
    await userEvent.click(screen.getByText("Cancel"));

    // The login is called off; the credential is not deleted.
    expect(fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(fetchCalls.some((c) => c.url.endsWith("/login/cancel"))).toBe(true);
  });

  /**
   * The dialog owns the sign-in, so step 3 opens on its WAITING panel. The
   * first cut fired `cancel → start` from the click handler, leaving the
   * dialog's `startingSignIn` false — which satisfies `signInStalled`, so
   * reconnect opened on "The sign-in stopped before the account connected."
   * with a *Try again*: the flow's failure screen, before the first request had
   * returned. Found by cross-backend review.
   */
  it("opens a reconnect on the waiting panel, never on the stalled one", async () => {
    seedConnected();
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));

    expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-signin-stalled")).toBeNull();
    // And it says what it is doing, and to which account — the plan's
    // "Reconnect Anthropic — Work plan", not "Add a service".
    expect(screen.getByTestId("add-service-title")).toHaveTextContent("Reconnect — Anthropic · Work");
  });

  /**
   * **The state a reconnect opens over belongs to the PREVIOUS attempt.**
   *
   * `providerAccountAuthErrors` is written by `agent_auth_failed` and cleared
   * only when the *next* challenge arrives — and the reason anyone presses
   * *Reconnect* is usually that the last attempt failed, so the reason it failed
   * is still filed against the account. `signInStalled` read it as this
   * attempt's outcome, so for the ~6 s Claude's wizard takes to print its link
   * the dialog drew its failure screen with a live *Try again*: the press had
   * worked, and the one control on screen inviting another press said it had
   * not. Reported from use.
   */
  it("does not show a failed attempt's reason over a reconnect that is running", async () => {
    seedConnected();
    // The credential expired; the toast that offers a reconnect is the reason
    // the user is here, and the failure is still in the store.
    useSettingsStore.getState().setProviderAccountAuthError(
      "anthropic-oauth", "acct_1", "Your Anthropic session expired.",
    );
    render(<ServicesPanel agentList={[claudeAgent]} />);

    await openRowMenu("Work");
    await userEvent.click(screen.getByTestId("provider-account-connect-acct_1"));
    // The server's `authenticating` broadcast lands — the sign-in is under way,
    // and the link has not been printed yet.
    act(() => {
      useSettingsStore.getState().setProviderAccounts([
        { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "authenticating", externalId: "ext-1", createdAt: now, updatedAt: now },
      ]);
    });

    expect(screen.getByTestId("add-service-signin-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("add-service-signin-stalled")).toBeNull();
    // The rule the dialog states for itself: while a sign-in runs there is one
    // button and it says Cancel.
    expect(screen.queryByTestId("add-service-sign-in")).toBeNull();
  });

  /**
   * The same defect wearing the row's status instead of a filed reason. An
   * expired credential sits at `auth_failed`, which is `status !==
   * "authenticating"` — so between the login request returning and the
   * broadcast landing, the dialog judged the attempt by the state the *previous*
   * one left. `reconnectLeftReady` does not cover this: "has left `ready`" is
   * answered `true` by `auth_failed` before the user presses anything.
   */
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

    // No broadcast yet — the row still says what the last attempt did.
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
    // The CLI gives up: the row fails and the reason is filed.
    act(() => {
      useSettingsStore.getState().setProviderAccounts([
        { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "auth_failed", externalId: "ext-1", createdAt: now, updatedAt: now },
      ]);
      useSettingsStore.getState().setProviderAccountAuthError(
        "anthropic-oauth", "acct_1", "The authorization code expired.",
      );
    });
    expect(screen.getByTestId("add-service-signin-stalled")).toHaveTextContent("The authorization code expired.");

    // Pressing it starts a second attempt, and the second attempt is no more
    // judged by the first one's wreckage than the first was by the one before.
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
    // The provider is busy with the other account, so the login is refused.
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

    // The refusal is the outcome, and the way back is the flow's own retry.
    expect(screen.getByTestId("add-service-signin-stalled")).toBeInTheDocument();
    expect(screen.getByTestId("add-service-sign-in")).toHaveTextContent("Try again");
    expect(screen.queryByTestId("add-service-signed-in")).toBeNull();
    expect(screen.queryByTestId("add-service-done")).toBeNull();
    // Said once, in the reason line the stalled panel is built around, rather
    // than as an aside under a screen claiming the opposite.
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
    // Still listed, still first, still Anthropic's — and no DELETE was sent for
    // it, which is the assertion that would catch an abandon aimed at the wrong
    // row rather than merely a store that had not caught up.
    const rows = screen.getAllByTestId(/^provider-account-row-acct_\d+$/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "provider-account-row-acct_1",
      "provider-account-row-acct_2",
    ]);
    expect(fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
  });
});

/**
 * docs/252 req 19 — the card is a header line and its credentials. Everything
 * removed here was on every card of its kind and said nothing about *this*
 * install; the one thing that moved rather than went is the model list.
 */
describe("the compact service card (docs/252 req 19)", () => {
  it("drops the per-card description prose", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    const card = screen.getByTestId("service-card-deepseek:key");
    // The metered fact is the API-key pill, one control to the left.
    expect(card).not.toHaveTextContent(/Metered — no quota to report/);
    expect(card).not.toHaveTextContent(/ShipIt fails over between them/);
  });

  it("moves the model ids into a corner control rather than a chip row", async () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);
    const control = screen.getByTestId("service-models-service-card-deepseek:key");
    // The count is what earns a glance. The chip row was the one element on the
    // card that grew with ShipIt's catalogue rather than with the user's setup.
    expect(control).toHaveTextContent(/^\d+ models?$/);

    // req 23 — and the names are no longer a hover either: the control opens the
    // one dialog, at this service. A tooltip of raw ids said less than it looked
    // like (no window, no price, no harness) and only for a configured service.
    await userEvent.click(control);
    expect(await screen.findByTestId("supported-models-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("supported-models-service-deepseek")).toBeInTheDocument();
  });

  it("opens the same dialog from the heading, with no service configured", async () => {
    // req 23 — the panel's own control, which had no test at all: only the card
    // route was covered, so a broken heading button stayed green (found by
    // cross-backend review). Asserted on an EMPTY panel, because the whole point
    // of this entry point is that it works before any credential exists.
    render(<ServicesPanel />);
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("services-supported-models"));
    expect(await screen.findByTestId("supported-models-dialog")).toBeInTheDocument();
    // Every service, on a panel listing none.
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
    // printed on every service whether or not there was anything to say.
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

/**
 * planning#454 — the SuperGrok card carries a NUMBER, not a sentence about not
 * having one.
 *
 * This card spent a release explaining an absence: ShipIt had concluded xAI
 * published no usage API, suppressed the pill, and printed a line saying so.
 * The conclusion was wrong — the weekly pool is one query parameter away — and
 * these cases exist to keep the apology from coming back. A sentence explaining
 * an empty surface is a last resort, and the reader is what makes it
 * unnecessary.
 */
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

  /**
   * The weekly figure on the account row, and — the half that was the reported
   * bug — NO second meter beside it. SuperGrok has one pool and no short
   * window, so a `5h · —` here would be the same permanently-empty read-out the
   * user reported, merely next to a real number.
   */
  it("shows the weekly figure on the account row, and no empty short window", () => {
    useSettingsStore.getState().setProviderAccounts([
      route({ id: "acct_xai", serviceId: "xai", billingMode: "sub", via: "account", label: "nik@x" }),
    ]);
    useUiStore.getState().setSubscriptionLimits({
      "xai:sub": {
        acct_xai: {
          // `plan: null` is deliberate, not a gap — see requirements.md, the
          // 2026-08-20 receipt: the plan name is reachable and was declined.
          serviceId: "xai", billingMode: "sub", routeId: "acct_xai", plan: null,
          session: null,
          weekly: { usedPct: 10, resetAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
          // The reader STATES the plan has one window; the pill does not infer
          // it from the null (planning#454).
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

    // Including the header count: "2 accounts" over two supplied credentials
    // on a card with no account at all is the exact conflation this feature
    // exists to remove.
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

  /**
   * planning#339 closed — GLM's coding plan reports a quota, so it gets both
   * halves of the band and a usage read-out on its rows, exactly as a
   * first-party subscription does. That is what req 15 asked the launch
   * subscription on a NON-first-party service to demonstrate.
   *
   * The rule this replaced is still the rule (a mode whose quota nobody reads
   * gets no cutoffs and no pill — req 10 prefers no indicator to a fictional
   * one); what changed is that no shipped service is on the wrong side of it
   * any more, so the rule itself is pinned on `modeReportsQuota` in
   * `catalogue.test.ts` rather than on a service that happens to lack a reader.
   */
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

  /**
   * The read-out itself. The compact row gave the quota pill to ACCOUNT rows
   * only, so the reporting install in the bug report — two Anthropic plan
   * tokens, no account — showed no numbers at all. The header pill has always
   * rendered one for these routes; only the row did not.
   */
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

  /**
   * And the guard the old reading was protecting stays: with an account AND a
   * string present they are genuinely not one pool — phase 5 returns an
   * `all_exhausted` account walk unchanged rather than falling through to the
   * token — so the strings get no order there. The reorder endpoint would
   * reject a list omitting the account anyway.
   */
  it("still refuses to order the strings once an account is present too", () => {
    twoStrings();
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", externalId: "ext-1", createdAt: now, updatedAt: now },
    ]);
    render(<ServicesPanel agentList={[claudeAgent]} />);

    expect(screen.queryByTestId("credential-row-cred_1-grip")).not.toBeInTheDocument();
    // One account is the whole pool, so the band has nothing to hold and is
    // absent rather than explaining itself.
    expect(screen.queryByTestId("service-routing-service-card-anthropic:sub")).not.toBeInTheDocument();
  });
});
