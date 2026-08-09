import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NewSessionRepoBar } from "./NewSessionRepoBar.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/259 — the mobile new-session screen's repo bar.
 *
 * The bar answers "which repo will this session be created in?" (reqs 1, 2) and
 * its picker is the way to change that answer without backing out through the
 * sessions drawer (req 3).
 */

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

/** The picker sheet, scoped so its rows don't collide with the bar's own label. */
function openPicker() {
  fireEvent.click(screen.getByTestId("new-session-repo-bar"));
  return within(screen.getByRole("dialog", { name: "Choose a repository" }));
}

afterEach(cleanup);

describe("NewSessionRepoBar", () => {
  it("names the repository the session will be created in", () => {
    renderBar();
    expect(screen.getByTestId("new-session-repo-bar")).toHaveTextContent("New session in");
    expect(screen.getByTestId("new-session-repo-bar")).toHaveTextContent("owner/alpha");
  });

  it("names the repo from the route slug before the repo list has loaded", () => {
    // `repo` resolves against the loaded repo list and is undefined until it
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
    // A row written before the docs/254 backfill gets no edge rather than an
    // arbitrary color — the same fallback the sidebar group header takes.
    renderBar({ repo: mkRepo(ALPHA.url, { colorIndex: undefined }) });
    const bar = screen.getByTestId("new-session-repo-bar");
    expect(bar.style.borderLeftColor).toBe("");
    expect(bar.style.backgroundColor).toBe("");
  });

  it("opens a picker listing every repo, checking the current one", () => {
    renderBar();
    const sheet = openPicker();

    expect(sheet.getByRole("button", { name: /owner\/alpha/ })).toHaveAttribute("aria-current", "true");
    expect(sheet.getByRole("button", { name: /owner\/beta/ })).not.toHaveAttribute("aria-current");
  });

  it("starts a session in the picked repo", () => {
    const { onSelectRepo } = renderBar();
    fireEvent.click(openPicker().getByRole("button", { name: /owner\/beta/ }));

    expect(onSelectRepo).toHaveBeenCalledWith(BETA.url);
    expect(screen.queryByRole("dialog", { name: "Choose a repository" })).toBeNull();
  });

  it("just closes when the current repo is re-picked", () => {
    // Re-claiming the session we're already in would reset the view and take
    // the draft the user just typed with it. Closing is the whole action.
    const { onSelectRepo } = renderBar();
    fireEvent.click(openPicker().getByRole("button", { name: /owner\/alpha/ }));

    expect(onSelectRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Choose a repository" })).toBeNull();
  });

  it("omits hidden repos from the picker", () => {
    // docs/222 — a hidden repo is out of the sidebar, so it stays out of here.
    renderBar({ repos: [ALPHA, mkRepo(BETA.url, { hidden: true })] });

    expect(openPicker().queryByRole("button", { name: /owner\/beta/ })).toBeNull();
  });

  it("lists the current repo even when it is hidden", () => {
    // Otherwise the picker would claim the user is somewhere they're not.
    const hiddenAlpha = mkRepo(ALPHA.url, { hidden: true });
    renderBar({ repo: hiddenAlpha, repos: [hiddenAlpha, BETA] });

    expect(openPicker().getByRole("button", { name: /owner\/alpha/ })).toHaveAttribute("aria-current", "true");
  });
});
