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
      useSettingsStore.getState().setProviderAccountAuth("codex", "acct-openai-1", {
        provider: "codex",
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

      useSettingsStore.getState().setProviderAccountAuth("codex", "acct-openai-1", {
        provider: "codex", accountId: "acct-openai-1",
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
      useSettingsStore.getState().setProviderAccountAuth("claude", "acct-anthropic-1", {
        provider: "claude", accountId: "acct-anthropic-1",
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

      useSettingsStore.getState().setProviderAccountAuth("claude", "acct-anthropic-2", {
        provider: "claude", accountId: "acct-anthropic-2",
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
    useSettingsStore.getState().setProviderAccountAuth("codex", "acct-openai-1", {
      provider: "codex",
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

    useSettingsStore.getState().setProviderAccountAuth("codex", "acct-openai-1", {
      provider: "codex",
      accountId: "acct-openai-1",
      verificationUri: "https://auth.openai.com/device",
      userCode: "WXYZ-1234",
    });
    await waitFor(() => expect(
      within(screen.getByTestId("add-service-dialog")).getByTestId("provider-account-challenge-acct-openai-1"),
    ).toBeInTheDocument());

    // What the failure event does: clear the challenge, file the reason.
    useSettingsStore.getState().setProviderAccountAuth("codex", "acct-openai-1", null);
    useSettingsStore.getState().setProviderAccountAuthError("codex", "acct-openai-1", "That code expired.");

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
    // service is connected by signing in, with *Save* primary. The key stays
    // reachable — it genuinely works — but under its own sub-heading.
    render(<ServicesPanel agentList={[claudeAgent]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));

    const step = screen.getByTestId("add-service-step-credential");
    expect(step).toHaveTextContent("3 · Sign in");
    expect(step).not.toHaveTextContent("3 · Paste the key");
    expect(screen.getByTestId("add-service-string-alternative")).toHaveTextContent("Or paste a key");

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
    expect(within(card).getByTestId("service-avatar-anthropic")).toHaveTextContent("A");
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
    // though the card holds three credentials.
    expect(screen.getByTestId("service-routing-service-card-anthropic:sub"))
      .toHaveTextContent(/One account — nothing to route between yet/);
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
   * D14 / planning#339 — a cutoff is a percentage of a *reported* quota, and
   * nothing reports one for a string-delivered plan yet, so the control would
   * set a number that can never fire.
   */
  it("offers the order but not the cutoffs on a string-delivered subscription", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", isPrimary: true }),
      route({ id: "cred_2", serviceId: "zai", billingMode: "sub", via: "string", priority: 1 }),
    ]);
    render(<ServicesPanel />);

    const band = screen.getByTestId("service-routing-service-card-zai:sub");
    expect(within(band).getByRole("radiogroup", { name: "How ShipIt picks between these credentials" }))
      .toBeInTheDocument();
    expect(within(band).getByTestId("credential-selection-mode-zai:sub")).toBeInTheDocument();
    expect(screen.queryByTestId("failover-cutoffs-zai:sub")).not.toBeInTheDocument();
  });

  it("names a lone subscription's next step, and says nothing on a key card", () => {
    useSettingsStore.getState().setCredentialRoutes([
      route({ id: "cred_1", serviceId: "zai", billingMode: "sub", via: "string", isPrimary: true }),
      route({ id: "cred_k", serviceId: "deepseek", billingMode: "key", via: "string" }),
    ]);
    render(<ServicesPanel />);

    expect(screen.getByTestId("service-routing-service-card-zai:sub"))
      .toHaveTextContent(/One credential — nothing to route between yet/);
    // req 12: a key card gets no band at all — not a disabled group, not an
    // empty section, and no sentence explaining the absence.
    expect(screen.queryByTestId("service-routing-service-card-deepseek:key")).not.toBeInTheDocument();
  });

  it("says nothing about routing on a subscription with no credential yet", () => {
    // req 17 leaves exactly one way for a card to be on screen with no
    // credential: a notice holding it open after the last account went.
    useSettingsStore.getState().setProviderAccountNotice("claude", {
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
 * otherwise derived from the account list). docs/260 req 3 narrowed what a
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

  it("drops the card silently when the LAST account disconnects — nothing left to say (docs/260 req 3)", async () => {
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

  it("keeps the card and lands the busy-process refusal on the row (docs/260 req 13)", async () => {
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
    useSettingsStore.getState().setProviderAccountNotice("claude", { kind: "info", message: "Disconnected." });
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
    // The count is what earns a glance; the names are worth a hover. The chip
    // row was the one element on the card that grew with ShipIt's catalogue
    // rather than with the user's setup.
    expect(control).toHaveTextContent(/^\d+ models?$/);

    await userEvent.hover(control);
    // Radix renders the content twice — visible plus a hidden aria copy.
    expect(await screen.findAllByText("deepseek-v4-pro")).not.toHaveLength(0);
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
    // No cutoffs: nothing reports a quota for a string-delivered plan yet
    // (planning#339), so the control would set a number that can never fire.
    expect(screen.queryByTestId("failover-cutoffs-anthropic:sub")).not.toBeInTheDocument();
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
    expect(screen.getByTestId("service-routing-service-card-anthropic:sub"))
      .toHaveTextContent(/One account — nothing to route between yet/);
  });
});
