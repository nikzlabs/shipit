import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSettings, type ProjectSettingsProps } from "./ProjectSettings.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { usePluginReposStore } from "../stores/plugin-repos-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

const REPO_URL = "https://github.com/org/repo";

/**
 * The secrets panel owns both of its requests since slice 7 — a registered
 * component takes the setting's key and nothing else, so the dialog no longer
 * passes a loader and a saver in. The stub answers the two it makes.
 */
let storedKeys: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Writes still in flight, newest last — each one answered by {@link answerSave}. */
let saveGate: ((ok: boolean) => void)[] = [];

function secretsFetch({ saveOk = true, getOk = true, deferSave = false } = {}) {
  const answer = (ok: boolean) => ({
    ok,
    status: ok ? 200 : 500,
    statusText: "Internal Server Error",
    json: () => Promise.resolve({ saved: ok }),
  });
  return vi.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.startsWith("/api/secrets") && (init?.method ?? "GET") === "GET") {
      return getOk
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ keys: storedKeys }) })
        : Promise.reject(new Error("offline in this test"));
    }
    if (url === "/api/secrets" && init?.method === "PUT") {
      if (!deferSave) return Promise.resolve(answer(saveOk));
      return new Promise((resolve) => { saveGate.push((ok) => { resolve(answer(ok)); }); });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

/** Answer the n-th write that is still waiting, oldest first. */
async function answerSave(index: number, ok = true) {
  await act(async () => {
    saveGate[index]?.(ok);
    await Promise.resolve();
  });
}

/** The body of the one `PUT /api/secrets` the panel sent. */
function savedPayload(): unknown {
  const put = fetchMock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === "PUT");
  return JSON.parse((put?.[1] as { body: string }).body);
}

/**
 * An open session on the same repository as the dialog. The declared secrets
 * come from the ACTIVE session's compose file, so the panel applies them only
 * where the two repositories agree — without this the tab is the custom-only
 * form, which is what a dialog opened for a different repository gets.
 */
function sessionOn(remoteUrl: string): SessionInfo {
  const now = new Date().toISOString();
  return { id: "sess-1", title: "s", createdAt: now, lastUsedAt: now, remoteUrl };
}

beforeEach(() => {
  storedKeys = [];
  saveGate = [];
  fetchMock = secretsFetch();
  vi.stubGlobal("fetch", fetchMock);
  useUiStore.getState().setProjectSettingsRepoUrl(REPO_URL);
  useSessionStore.setState({ sessionId: "sess-1", sessions: [sessionOn(REPO_URL)] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionStore.setState({ sessionId: undefined, sessions: [] });
  useUiStore.getState().setToast(null);
  useUiStore.getState().setProjectSettingsRepoUrl(null);
  usePreviewStore.getState().setSecrets({
    declared: [],
    missingByService: {},
    missingRequired: [],
  });
});

const defaultProps: ProjectSettingsProps = {
  onClose: vi.fn(),
};

describe("ProjectSettings", () => {
  /*
    The title names the repository the dialog was OPENED for, read from the same
    place every row reads it (slice 7) — so the header and the rows can never
    describe two different repositories.
  */
  it("renders dialog with header and the open repository's name", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Project Settings")).toBeInTheDocument();
    expect(screen.getByText("org/repo")).toBeInTheDocument();
  });

  it("opens on the Secrets tab by default", async () => {
    render(<ProjectSettings {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("secrets-tab")).toBeInTheDocument();
    });
  });

  it("opens on the Deployments tab when initialTab is deployments", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByTestId("deployments-tab")).toBeInTheDocument();
  });

  it("calls onClose on Escape key", async () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on close button (x) click", async () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ProjectSettings - Deployments tab", () => {
  it("shows setup guide", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByTestId("deployments-tab")).toBeInTheDocument();
    expect(screen.getByText("Automatic Deployments")).toBeInTheDocument();
  });

  it("shows platform links", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
    expect(screen.getByText("Netlify")).toBeInTheDocument();
  });

  it("shows how-it-works steps", () => {
    render(<ProjectSettings {...defaultProps} initialTab="deployments" />);
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByText(/Deploy status appears/)).toBeInTheDocument();
  });
});

/**
 * The Secrets tab is the panel `project.secrets` names, placed by the generated
 * block (docs/308-data-driven-settings slice 7). It keeps its own reader and
 * writer, as every registered panel does — so what these drive is the two
 * requests it makes, where they used to be callbacks the dialog passed in.
 */
describe("ProjectSettings - Secrets tab", () => {
  function renderOnSecretsTab(keys: string[] = []) {
    storedKeys = keys;
    return render(<ProjectSettings {...defaultProps} initialTab="secrets" />);
  }

  it("renders secrets tab content", async () => {
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secrets-tab")).toBeInTheDocument();
    });
  });

  /*
    The names are one repository's, and the panel is opened for one repository
    at a time — so the read carries the repository the dialog was opened for
    rather than whichever one is active (slice 7).
  */
  it("asks for the names of the repository the dialog is open for", async () => {
    renderOnSecretsTab(["API_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/secrets?repoUrl=${encodeURIComponent(REPO_URL)}`,
    );
  });

  it("loads existing secret names on render (values never sent to client)", async () => {
    renderOnSecretsTab(["API_KEY"]);

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
    // The value field is blank (the browser never received the value) and

    expect(screen.getByTestId("secret-value-0")).toHaveValue("");
    expect(screen.getByTestId("secret-value-0")).toHaveAttribute(
      "placeholder",
      expect.stringContaining("saved"),
    );
  });

  it("adds a new row when Add variable is clicked", async () => {
    renderOnSecretsTab();

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));
    expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
  });

  it("removes a row when remove button is clicked", async () => {
    renderOnSecretsTab(["KEY_A", "KEY_B"]);

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-remove-0"));
    expect(screen.queryByTestId("secret-key-1")).not.toBeInTheDocument();
  });

  it("stores a set/keep payload for this repository on save", async () => {
    renderOnSecretsTab();

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));
    fireEvent.change(screen.getByTestId("secret-key-0"), { target: { value: "MY_KEY" } });
    fireEvent.change(screen.getByTestId("secret-value-0"), { target: { value: "my_value" } });

    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(savedPayload()).toEqual({
        repoUrl: REPO_URL,
        set: { MY_KEY: "my_value" },
        keep: [],
      });
    });
  });

  /*
    "Saved" is the server's answer rather than a timer's since the panel owns
    the write. The refusal half matters more: it used to be swallowed by the
    dialog's fire-and-forget saver, so a failed save looked exactly like a
    successful one.
  */
  it("says Saved once the write has landed", async () => {
    renderOnSecretsTab(["API_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });

    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(screen.getByTestId("secrets-save")).toHaveTextContent("Saved");
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("reports a refused write instead of saying Saved", async () => {
    fetchMock = secretsFetch({ saveOk: false });
    vi.stubGlobal("fetch", fetchMock);
    renderOnSecretsTab(["API_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });

    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(useUiStore.getState().toast?.message).toContain("Failed to save");
    });
    expect(screen.getByTestId("secrets-save")).toHaveTextContent("Save");
    expect(screen.getByTestId("secrets-save")).not.toHaveTextContent("Saved");
  });

  /*
    Every one of these is a defect the independent review found and reproduced.
  */

  it("stays usable once the write lands, however long the plugin refresh takes", async () => {
    fetchMock = secretsFetch({ deferSave: true });
    vi.stubGlobal("fetch", fetchMock);
    // The refresh that follows a save is not part of the save: awaiting a
    // snapshot that never answers used to leave Save disabled for ever.
    usePluginReposStore.setState({ fetchSnapshot: () => new Promise<void>(() => {}) } as never);
    renderOnSecretsTab(["API_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });

    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(screen.getByTestId("secrets-save")).toBeDisabled();

    await answerSave(0);
    expect(screen.getByTestId("secrets-save")).toBeEnabled();
    expect(screen.getByTestId("secrets-save")).toHaveTextContent("Saved");
  });

  it("does not call a value typed during the write Saved", async () => {
    fetchMock = secretsFetch({ deferSave: true });
    vi.stubGlobal("fetch", fetchMock);
    renderOnSecretsTab(["API_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secrets-save"));
    fireEvent.change(screen.getByTestId("secret-value-0"), { target: { value: "typed-later" } });
    await answerSave(0);

    // The box still holds what was typed, and the server does not have it.
    expect(screen.getByTestId("secret-value-0")).toHaveValue("typed-later");
    expect(screen.getByTestId("secrets-save")).not.toHaveTextContent("Saved");
  });

  /*
    Switching tabs unmounts the panel, so a second save can begin while the
    first is still out. The older answer describes a state nobody is in any
    more — and a toast from it would report a failure the newer write fixed.
  */
  it("reports nothing from a save a newer one has superseded", async () => {
    fetchMock = secretsFetch({ deferSave: true });
    vi.stubGlobal("fetch", fetchMock);
    renderOnSecretsTab(["API_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
    await userEvent.click(screen.getByTestId("secrets-save"));

    await userEvent.click(screen.getByTestId("project-tab-deployments"));
    await userEvent.click(screen.getByTestId("project-tab-secrets"));
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
    await userEvent.click(screen.getByTestId("secrets-save"));
    await answerSave(1);
    await answerSave(0, false);

    expect(useUiStore.getState().toast).toBeNull();
    expect(screen.getByTestId("secrets-save")).toHaveTextContent("Saved");
  });

  /*
    A failed read is not a repository with no secrets: Save replaces the stored
    set with what is on screen, so offering it after a failed read is a
    delete-everything button.
  */
  it("offers no Save when the names could not be read", async () => {
    fetchMock = secretsFetch({ getOk: false });
    vi.stubGlobal("fetch", fetchMock);
    renderOnSecretsTab(["API_KEY"]);

    expect(await screen.findByTestId("secrets-load-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("secrets-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("secret-key-0")).not.toBeInTheDocument();

    fetchMock = secretsFetch();
    vi.stubGlobal("fetch", fetchMock);
    await userEvent.click(screen.getByTestId("secrets-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
  });

  /*
    The declared names come from the ACTIVE session's compose file. Applying
    them to another repository's dialog hid a stored key from the custom rows,
    and a hidden key is in neither `set` nor `keep` — so saving deleted it.
  */
  it("does not apply another repository's declarations, or drop a secret to them", async () => {
    useSessionStore.setState({
      sessionId: "sess-1",
      sessions: [sessionOn("https://github.com/org/elsewhere")],
    });
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "API_KEY", source: "platform:github_token", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab(["API_KEY"]);

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
    expect(screen.queryByTestId("secrets-declared-section")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(savedPayload()).toEqual({ repoUrl: REPO_URL, set: {}, keep: ["API_KEY"] });
    });
  });

  it("keeps an untouched existing custom secret without resending its value", async () => {
    renderOnSecretsTab(["API_KEY"]);

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });

    // Don't touch the value — save must keep it by name only.
    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(savedPayload()).toEqual({ repoUrl: REPO_URL, set: {}, keep: ["API_KEY"] });
    });
  });

  it("secret values use password input type", async () => {
    renderOnSecretsTab(["KEY"]);

    await waitFor(() => {
      expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
    });
    expect(screen.getByTestId("secret-value-0")).toHaveAttribute("type", "password");
  });

  it("renders declared secrets from preview-store snapshot", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api", "web"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });
    expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toHaveTextContent("api");
    expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toHaveTextContent("web");
  });

  it("shows Required indicator when value is missing", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "DATABASE_URL", required: true, services: ["api"] }],
      missingByService: { api: ["DATABASE_URL"] },
      missingRequired: ["DATABASE_URL"],
    });
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secret-required-DATABASE_URL")).toBeInTheDocument();
    });
  });

  it("renders platform-sourced rows as read-only", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "GITHUB_TOKEN", source: "platform:github_token", services: ["orchestrator"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secret-platform-GITHUB_TOKEN")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("secret-value-GITHUB_TOKEN")).not.toBeInTheDocument();
  });

  it("editing a declared (non-platform) value persists it on save", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secret-value-STRIPE_KEY")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("secret-value-STRIPE_KEY"), {
      target: { value: "sk_live_x" },
    });
    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(savedPayload()).toEqual({
        repoUrl: REPO_URL,
        set: { STRIPE_KEY: "sk_live_x" },
        keep: [],
      });
    });
  });

  // a row. The key must still move into the declared section rather than

  it("moves a stored key out of Custom variables when it becomes declared", async () => {
    renderOnSecretsTab(["STRIPE_KEY", "OTHER"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });

    await userEvent.click(screen.getByTestId("secret-add"));

    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });

    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });
    const customKeys = screen
      .getAllByTestId(/^secret-key-\d+$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(customKeys).not.toContain("STRIPE_KEY");
    expect(customKeys).toContain("OTHER");
  });

  // The rendered custom list is filtered, so row handlers must index the

  it("removes the clicked custom row after a key moved to the declared section", async () => {
    renderOnSecretsTab(["STRIPE_KEY", "KEEP_ME", "DROP_ME"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });

    await userEvent.click(screen.getByTestId("secret-add"));

    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("KEEP_ME");
    });

    await userEvent.click(screen.getByTestId("secret-remove-1"));
    const customKeys = screen
      .getAllByTestId(/^secret-key-\d+$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(customKeys).toEqual(["KEEP_ME", ""]);
  });

  it("does not drop a stored key that was hidden while declared and then undeclared", async () => {
    renderOnSecretsTab(["STRIPE_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });

    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));

    usePreviewStore.getState().setSecrets({
      declared: [],
      missingByService: {},
      missingRequired: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("STRIPE_KEY");
    });

    await userEvent.click(screen.getByTestId("secrets-save"));
    await waitFor(() => {
      expect(savedPayload()).toEqual({ repoUrl: REPO_URL, set: {}, keep: ["STRIPE_KEY"] });
    });
  });

  it("clears a set declared value via the Clear control", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });

    renderOnSecretsTab(["STRIPE_KEY"]);
    await waitFor(() => {
      expect(screen.getByTestId("secret-clear-STRIPE_KEY")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-clear-STRIPE_KEY"));
    await userEvent.click(screen.getByTestId("secrets-save"));

    await waitFor(() => {
      expect(savedPayload()).toEqual({ repoUrl: REPO_URL, set: {}, keep: [] });
    });
  });
});
