import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { NewSessionRepoBar } from "./NewSessionRepoBar.js";
import type { RepoInfo } from "../../server/shared/types.js";

const now = "2026-01-01T00:00:00Z";

function mkRepo(url: string, overrides: Partial<RepoInfo> = {}): RepoInfo {
  return { url, status: "ready", addedAt: now, lastUsedAt: now, colorIndex: 6, ...overrides };
}

const ALPHA = mkRepo("https://github.com/owner/alpha.git");
const BETA = mkRepo("https://github.com/owner/beta.git", { colorIndex: 12 });

function renderBar(overrides: Partial<Parameters<typeof NewSessionRepoBar>[0]> = {}) {
  const onSelectRepo = overrides.onSelectRepo ?? vi.fn();
  render(
    <NewSessionRepoBar
      repoSlug="owner/alpha"
      repo={ALPHA}
      repos={[ALPHA, BETA]}
      {...overrides}
      onSelectRepo={onSelectRepo}
    />,
  );
  return { onSelectRepo };
}

function openPicker() {
  fireEvent.click(screen.getByTestId("new-session-repo-bar"));
  return within(sheet()!);
}

function sheet() {
  return screen.queryByRole("dialog", { name: "Start this session in" });
}

afterEach(cleanup);

describe("NewSessionRepoBar", () => {
  it("names the repository the session will be created in", () => {
    renderBar();
    expect(screen.getByTestId("new-session-repo-bar")).toHaveTextContent("New session in");
    expect(screen.getByTestId("new-session-repo-bar")).toHaveTextContent("owner/alpha");
  });

  it("names the repo from the route slug before the repo list has loaded", () => {

    // arrives — the bar must still say where the user is rather than flash empty.
    renderBar({ repo: undefined });
    expect(screen.getByTestId("new-session-repo-bar")).toHaveTextContent("owner/alpha");
  });

  it("carries the repo's docs/254 identity color", () => {
    renderBar();
    const bar = screen.getByTestId("new-session-repo-bar");
    expect(bar.style.borderLeftColor).toBe("var(--repo-color-6)");
    expect(bar.style.backgroundColor).toContain("var(--repo-color-6)");
  });

  it("drops the color treatment for a repo with no colorIndex", () => {

    renderBar({ repo: mkRepo(ALPHA.url, { colorIndex: undefined }) });
    const bar = screen.getByTestId("new-session-repo-bar");
    expect(bar.style.borderLeftColor).toBe("");
    expect(bar.style.backgroundColor).toBe("");
  });

  it("opens a picker listing every repo, checking the current one", () => {
    renderBar();
    const picker = openPicker();

    expect(picker.getByRole("button", { name: /owner\/alpha/ })).toHaveAttribute("aria-current", "true");
    expect(picker.getByRole("button", { name: /owner\/beta/ })).not.toHaveAttribute("aria-current");
  });

  it("starts a session in the picked repo", () => {
    const { onSelectRepo } = renderBar();
    fireEvent.click(openPicker().getByRole("button", { name: /owner\/beta/ }));

    expect(onSelectRepo).toHaveBeenCalledWith(BETA.url);
    expect(sheet()).toBeNull();
  });

  it("just closes when the current repo is re-picked", () => {

    const { onSelectRepo } = renderBar();
    fireEvent.click(openPicker().getByRole("button", { name: /owner\/alpha/ }));

    expect(onSelectRepo).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("distinguishes repos whose labels collide", () => {

    const v1 = mkRepo("https://github.com/owner/api.v1.git");
    const v2 = mkRepo("https://github.com/owner/api.v2.git", { colorIndex: 12 });
    const { onSelectRepo } = renderBar({ repoSlug: "owner/api", repo: v1, repos: [v1, v2] });

    const rows = openPicker().getAllByRole("button", { name: /owner\/api/ });
    expect(rows.filter((r) => r.getAttribute("aria-current") === "true")).toHaveLength(1);

    fireEvent.click(rows[1]);
    expect(onSelectRepo).toHaveBeenCalledWith(v2.url);
  });

  it("closes the picker on Escape", () => {
    renderBar();
    openPicker();
    fireEvent.keyDown(sheet()!, { key: "Escape" });
    expect(sheet()).toBeNull();
  });

  it("moves focus into the sheet, onto the current repo", () => {
    renderBar();
    const current = openPicker().getByRole("button", { name: /owner\/alpha/ });
    expect(document.activeElement).toBe(current);
  });

  it("returns focus to the bar when the picker closes", async () => {

    // Async because Radix's focus scope restores on a timeout after unmount.
    renderBar();
    const bar = screen.getByTestId("new-session-repo-bar");
    fireEvent.keyDown(openPicker().getByRole("button", { name: /owner\/alpha/ }), { key: "Escape" });

    expect(sheet()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(bar));
  });

  it("meets the 44px mobile touch floor", () => {
    renderBar();
    expect(screen.getByTestId("new-session-repo-bar").className).toContain("min-h-11");
  });

  it("omits hidden repos from the picker", () => {

    renderBar({ repos: [ALPHA, mkRepo(BETA.url, { hidden: true })] });

    expect(openPicker().queryByRole("button", { name: /owner\/beta/ })).toBeNull();
  });

  it("lists the current repo even when it is hidden", () => {

    const hiddenAlpha = mkRepo(ALPHA.url, { hidden: true });
    renderBar({ repo: hiddenAlpha, repos: [hiddenAlpha, BETA] });

    expect(openPicker().getByRole("button", { name: /owner\/alpha/ })).toHaveAttribute("aria-current", "true");
  });
});
