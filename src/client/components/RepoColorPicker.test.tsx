import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoColorPicker } from "./RepoColorPicker.js";
import { useRepoStore } from "../stores/repo-store.js";
import { REPO_COLOR_COUNT, REPO_COLOR_NAMES } from "../../server/shared/repo-colors.js";
import type { RepoInfo } from "../../server/shared/types.js";

const now = new Date().toISOString();
const url = "https://github.com/owner/repo.git";
const repo: RepoInfo = { url, status: "ready", addedAt: now, lastUsedAt: now, colorIndex: 3 };

let setRepoColorIndex: (url: string, colorIndex: number) => Promise<boolean>;

beforeEach(() => {
  setRepoColorIndex = vi.fn<(url: string, colorIndex: number) => Promise<boolean>>().mockResolvedValue(true);
  useRepoStore.setState({ repos: [repo], setRepoColorIndex });
});

afterEach(() => {
  cleanup();
  useRepoStore.setState({ repos: [] });
});

describe("RepoColorPicker", () => {
  it("renders one swatch per palette entry", () => {
    render(<RepoColorPicker repoUrl={url} />);
    expect(screen.getAllByRole("radio")).toHaveLength(REPO_COLOR_COUNT);
  });

  // The swatch must paint with the SAME custom property the sidebar edge uses,
  // or the picker shows one color and the rail draws another.
  it("paints each swatch with its own palette custom property", () => {
    render(<RepoColorPicker repoUrl={url} />);
    const swatch = screen.getByTestId("repo-color-7");
    expect(swatch.style.backgroundColor).toBe("var(--repo-color-7)");
  });

  it("marks the repo's current color as selected", () => {
    render(<RepoColorPicker repoUrl={url} />);
    expect(screen.getByTestId("repo-color-3").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("repo-color-4").getAttribute("aria-checked")).toBe("false");
  });

  it("labels each swatch so it is identifiable without color", () => {
    render(<RepoColorPicker repoUrl={url} />);
    for (const name of REPO_COLOR_NAMES) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  it("persists the pick through the store", async () => {
    render(<RepoColorPicker repoUrl={url} />);
    await userEvent.click(screen.getByTestId("repo-color-11"));
    expect(setRepoColorIndex).toHaveBeenCalledWith(url, 11);
  });

  // A repo written before the backfill migration has no color: the picker must
  // still render, with nothing selected, rather than crashing or guessing.
  it("renders with no selection when the repo has no stored color", () => {
    useRepoStore.setState({ repos: [{ ...repo, colorIndex: undefined }] });
    render(<RepoColorPicker repoUrl={url} />);
    expect(screen.queryByRole("radio", { checked: true })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(REPO_COLOR_COUNT);
  });

  // req 5 — the no-collision guarantee covers AUTOMATIC assignment; a manual
  // pick may duplicate. The marking is the safeguard that makes that safe, so
  // it's a requirement in its own right, not a nicety.
  describe("colors taken by other repos", () => {
    const other = (u: string, colorIndex: number): RepoInfo =>
      ({ url: u, status: "ready", addedAt: now, lastUsedAt: now, colorIndex });

    it("marks a color another repo is using", () => {
      useRepoStore.setState({ repos: [repo, other("https://github.com/owner/b.git", 9)] });
      render(<RepoColorPicker repoUrl={url} />);
      expect(screen.getByTestId("repo-color-9").getAttribute("data-taken")).toBe("true");
      expect(screen.getByTestId("repo-color-8").getAttribute("data-taken")).toBeNull();
    });

    it("names the holder in the accessible label, not just a visual dot", () => {
      useRepoStore.setState({ repos: [repo, other("https://github.com/owner/b.git", 9)] });
      render(<RepoColorPicker repoUrl={url} />);
      expect(screen.getByRole("radio", { name: /already used by b/ })).toBeTruthy();
    });

    it("does not mark this repo's own color as taken", () => {
      useRepoStore.setState({ repos: [repo] });
      render(<RepoColorPicker repoUrl={url} />);
      expect(screen.getByTestId("repo-color-3").getAttribute("data-taken")).toBeNull();
    });

    // A hidden repo still holds its color and can return at any time.
    it("counts hidden repos as holders", () => {
      useRepoStore.setState({
        repos: [repo, { ...other("https://github.com/owner/b.git", 9), hidden: true }],
      });
      render(<RepoColorPicker repoUrl={url} />);
      expect(screen.getByTestId("repo-color-9").getAttribute("data-taken")).toBe("true");
    });

    it("still allows picking a taken color", async () => {
      useRepoStore.setState({ repos: [repo, other("https://github.com/owner/b.git", 9)], setRepoColorIndex });
      render(<RepoColorPicker repoUrl={url} />);
      await userEvent.click(screen.getByTestId("repo-color-9"));
      expect(setRepoColorIndex).toHaveBeenCalledWith(url, 9);
    });
  });
});
