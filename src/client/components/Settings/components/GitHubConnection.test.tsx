/**
 * The GitHub credential row (docs/308-data-driven-settings slice 5, P2, P10, P13).
 *
 * The three things that make it a component rather than a generated control are
 * what this covers: the write's address comes from the declaration but its
 * ANSWER is used, removing is a second address, and being configured is the
 * account rather than the value.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubConnection } from "./GitHubConnection.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { usePrStore } from "../../../stores/pr-store.js";
import { findSetting, type SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

const KEY = "integrations.github.connection" as SettingKey;

let fetchMock: ReturnType<typeof vi.fn>;

function answerWith(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({ ok, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  fetchMock = vi.fn();
  answerWith({ status: { authenticated: true, username: "octocat" }, repos: [] });
  vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.getState().setGithubStatus({ authenticated: false });
  usePrStore.getState().setImportSearchResults([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.getState().setToast(null);
});

function paste(token: string) {
  fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: token } });
  return userEvent.click(screen.getByTestId("github-token-submit"));
}

describe("the GitHub credential row", () => {
  /*
    The address is the declaration's, which is what P2 replaced a sentence with.
    Asserted against the declaration rather than against the string, so moving
    the route moves this row with it and nothing here has to be edited.
  */
  it("posts the token to the address its declaration names, under its own field", async () => {
    render(<GitHubConnection settingKey={KEY} />);
    await paste("ghp_abc");

    const route = findSetting(KEY)!.store as { method: string; path: string; bodyField: string };
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(route.path, expect.objectContaining({
        method: route.method,
        body: JSON.stringify({ [route.bodyField]: "ghp_abc" }),
      }));
    });
  });

  /*
    inventory.md P3 — the answer carries the repositories the Add Repository
    dialog lists, so this write has a client-side effect and a generated row's
    writer, which awaits the response and does nothing else, could not have it.
  */
  it("seeds the repository list from the token's answer", async () => {
    answerWith({
      status: { authenticated: true, username: "octocat" },
      repos: [{ fullName: "acme/app", description: null, private: false, defaultBranch: "main", cloneUrl: "git@x" }],
    });
    render(<GitHubConnection settingKey={KEY} />);
    await paste("ghp_abc");

    await waitFor(() =>
      expect(usePrStore.getState().importSearchResults.map((r) => r.fullName)).toEqual(["acme/app"]));
  });

  /*
    The dialog used to swallow this: its caller returned `undefined` whether the
    token was accepted or refused, so a mistyped token cleared nothing and said
    nothing. The gate reported it and the settings row did not.
  */
  it("says why a refused token was refused", async () => {
    answerWith({}, false);
    render(<GitHubConnection settingKey={KEY} />);
    await paste("nope");

    expect(await screen.findByTestId("github-token-error")).toHaveTextContent("Invalid GitHub token");
  });

  it("names the connected account, and offers Disconnect only then", async () => {
    render(<GitHubConnection settingKey={KEY} />);
    expect(screen.getByTestId("settings-github-status")).toHaveTextContent("Not connected");
    expect(screen.queryByTestId("settings-disconnect")).toBeNull();

    await paste("ghp_abc");

    await waitFor(() =>
      expect(screen.getByTestId("settings-github-status")).toHaveTextContent("Connected as octocat"));
    expect(screen.getByTestId("settings-disconnect")).toBeInTheDocument();
  });

  /*
    A stored credential must not sit in the box afterwards. Until this row, a
    successful connect swapped the form for the connected card and unmounted it;
    the row keeps the form so the credential can be REPLACED, so the token
    stayed in the input with Replace enabled — and survived a disconnect.
  */
  it("clears the token box once the credential is stored", async () => {
    render(<GitHubConnection settingKey={KEY} />);
    await paste("ghp_abc");

    await waitFor(() => expect(screen.getByTestId("github-token-input")).toHaveValue(""));
  });

  /*
    The box stays editable while the request is out, so a token typed in SINCE
    the save is the user's unsaved work — only the value that was SENT is
    cleared. The same rule slices 3 and 4 settled for every other write here.
  */
  it("clears only the token that was sent", async () => {
    let land: (() => void) | undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      land = () => { resolve({ ok: true, json: () => Promise.resolve({ status: { authenticated: true, username: "octocat" }, repos: [] }) }); };
    }));
    render(<GitHubConnection settingKey={KEY} />);

    await paste("ghp_first");
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_second" } });
    await act(async () => { land?.(); });

    expect(screen.getByTestId("github-token-input")).toHaveValue("ghp_second");
  });

  // A refused token is the user's unsaved work: it stays to be corrected.
  it("keeps a refused token in the box", async () => {
    answerWith({}, false);
    render(<GitHubConnection settingKey={KEY} />);
    await paste("ghp_typo");

    expect(await screen.findByTestId("github-token-error")).toBeInTheDocument();
    expect(screen.getByTestId("github-token-input")).toHaveValue("ghp_typo");
  });

  /*
    Replace and Disconnect are two writes over ONE credential, so they must not
    overlap: a validation landing after a logout stores a token the user has just
    removed, and a connect answering late puts a connection back on screen that
    the server no longer holds.
  */
  it("will not disconnect while a replacement is in flight", async () => {
    useSettingsStore.getState().setGithubStatus({ authenticated: true, username: "octocat" });
    let land: (() => void) | undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      land = () => { resolve({ ok: true, json: () => Promise.resolve({ status: { authenticated: true, username: "octocat" }, repos: [] }) }); };
    }));
    render(<GitHubConnection settingKey={KEY} />);

    await paste("ghp_new");
    await waitFor(() => expect(screen.getByTestId("settings-disconnect")).toBeDisabled());

    await act(async () => { land?.(); });
    await waitFor(() => expect(screen.getByTestId("settings-disconnect")).toBeEnabled());
  });

  it("will not replace while a disconnect is in flight", async () => {
    useSettingsStore.getState().setGithubStatus({ authenticated: true, username: "octocat" });
    fetchMock.mockImplementation(() => new Promise(() => { /* never lands */ }));
    render(<GitHubConnection settingKey={KEY} />);

    await userEvent.click(screen.getByTestId("settings-disconnect"));
    await userEvent.click(screen.getByTestId("settings-disconnect"));

    await waitFor(() => expect(screen.getByTestId("github-token-input")).toBeDisabled());
    expect(screen.getByTestId("github-token-submit")).toBeDisabled();
  });

  /** "Configured or not, replace, remove" — the middle one, with one stored. */
  it("replaces a stored credential through the same address", async () => {
    useSettingsStore.getState().setGithubStatus({ authenticated: true, username: "octocat" });
    render(<GitHubConnection settingKey={KEY} />);

    expect(screen.getByTestId("github-token-submit")).toHaveTextContent("Replace");
    await paste("ghp_new");

    const route = findSetting(KEY)!.store as { path: string };
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === route.path)).toBe(true));
  });

  /*
    A refused removal used to fail silently, which is worse here than anywhere
    else: the status line is the only thing the user has, because the token is
    never read back, so a card that stayed connected with nothing said reads as a
    click that did not register.
  */
  it("says so when the disconnect is refused, and stays connected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useSettingsStore.getState().setGithubStatus({ authenticated: true, username: "octocat" });
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<GitHubConnection settingKey={KEY} />);

    await userEvent.click(screen.getByTestId("settings-disconnect"));
    await userEvent.click(screen.getByTestId("settings-disconnect"));

    await waitFor(() =>
      expect(useUiStore.getState().toast?.message).toBe("Failed to disconnect GitHub"));
    expect(screen.getByTestId("settings-github-status")).toHaveTextContent("Connected as octocat");
  });

  /*
    Removing is an operation on the connection at an address of its own, which is
    why it stays the component's — no value write clears a credential.
  */
  it("takes two presses to disconnect, and then asks the logout route", async () => {
    useSettingsStore.getState().setGithubStatus({ authenticated: true, username: "octocat" });
    answerWith({ status: { authenticated: false } });
    render(<GitHubConnection settingKey={KEY} />);

    const button = screen.getByTestId("settings-disconnect");
    await userEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button).toHaveAccessibleName("Click again to disconnect GitHub");

    await userEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/github/logout", expect.anything()));
    await waitFor(() =>
      expect(screen.getByTestId("settings-github-status")).toHaveTextContent("Not connected"));
  });
});
