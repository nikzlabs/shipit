import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { NewSessionRepoBar } from "./NewSessionRepoBar.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/259 — the new-session screen's repo bar, on every viewport.
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
  return within(sheet()!);
}

/** The open sheet, or null. Named by its own visible heading (a `DialogTitle`). */
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
    // Re-claiming the session we're already in would reset the view and take
    // the draft the user just typed with it. Closing is the whole action.
    const { onSelectRepo } = renderBar();
    fireEvent.click(openPicker().getByRole("button", { name: /owner\/alpha/ }));

    expect(onSelectRepo).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("distinguishes repos whose labels collide", () => {
    // `parseRepoLabel` truncates a repo name at its first dot, so `api.v1` and
    // `api.v2` both render as `owner/api`. Selection is by URL, so exactly one
    // row is marked current and the other is still switchable — a label
    // comparison would mark both and then refuse to switch to either.
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
    // Desktop reaches this sheet by keyboard, and a dialog that drops focus on
    // <body> restarts the user's next Tab at the top of the document. The
    // hand-rolled role="dialog" div this replaced did exactly that.
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
