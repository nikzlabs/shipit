import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoColorPicker } from "./RepoColorPicker.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { REPO_COLOR_COUNT, REPO_COLOR_NAMES } from "../../server/shared/repo-colors.js";
import type { RepoInfo } from "../../server/shared/types.js";

const now = new Date().toISOString();
const url = "https://github.com/owner/repo.git";
const repo: RepoInfo = { url, status: "ready", addedAt: now, lastUsedAt: now, colorIndex: 3 };

let setRepoColorIndex: (url: string, colorIndex: number) => Promise<boolean>;

beforeEach(() => {
  setRepoColorIndex = vi.fn<(url: string, colorIndex: number) => Promise<boolean>>().mockResolvedValue(true);
  useRepoStore.setState({ repos: [repo], setRepoColorIndex });
  // The picker is a generated row for one repository: it reads the one the
  // dialog was opened for rather than taking it as a prop (slice 7).
  useUiStore.getState().setProjectSettingsRepoUrl(url);
});

afterEach(() => {
  cleanup();
  useRepoStore.setState({ repos: [] });
  useUiStore.getState().setProjectSettingsRepoUrl(null);
});

describe("RepoColorPicker", () => {
  it("renders one swatch per palette entry", () => {
    render(<RepoColorPicker />);
    expect(screen.getAllByRole("radio")).toHaveLength(REPO_COLOR_COUNT);
  });

  // The swatch must paint with the SAME custom property the sidebar edge uses,

  it("paints each swatch with its own palette custom property", () => {
    render(<RepoColorPicker />);
    const swatch = screen.getByTestId("repo-color-7");
    expect(swatch.style.backgroundColor).toBe("var(--repo-color-7)");
  });

  it("marks the repo's current color as selected", () => {
    render(<RepoColorPicker />);
    expect(screen.getByTestId("repo-color-3").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("repo-color-4").getAttribute("aria-checked")).toBe("false");
  });

  it("labels each swatch so it is identifiable without color", () => {
    render(<RepoColorPicker />);
    for (const name of REPO_COLOR_NAMES) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  it("persists the pick through the store", async () => {
    render(<RepoColorPicker />);
    await userEvent.click(screen.getByTestId("repo-color-11"));
    expect(setRepoColorIndex).toHaveBeenCalledWith(url, 11);
  });

  // A repo written before the backfill migration has no color: the picker must

  it("renders with no selection when the repo has no stored color", () => {
    useRepoStore.setState({ repos: [{ ...repo, colorIndex: undefined }] });
    render(<RepoColorPicker />);
    expect(screen.queryByRole("radio", { checked: true })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(REPO_COLOR_COUNT);
  });

  describe("colors taken by other repos", () => {
    const other = (u: string, colorIndex: number): RepoInfo =>
      ({ url: u, status: "ready", addedAt: now, lastUsedAt: now, colorIndex });

    it("marks a color another repo is using", () => {
      useRepoStore.setState({ repos: [repo, other("https://github.com/owner/b.git", 9)] });
      render(<RepoColorPicker />);
      expect(screen.getByTestId("repo-color-9").getAttribute("data-taken")).toBe("true");
      expect(screen.getByTestId("repo-color-8").getAttribute("data-taken")).toBeNull();
    });

    it("names the holder in the accessible label, not just a visual dot", () => {
      useRepoStore.setState({ repos: [repo, other("https://github.com/owner/b.git", 9)] });
      render(<RepoColorPicker />);
      expect(screen.getByRole("radio", { name: /already used by b/ })).toBeTruthy();
    });

    it("does not mark this repo's own color as taken", () => {
      useRepoStore.setState({ repos: [repo] });
      render(<RepoColorPicker />);
      expect(screen.getByTestId("repo-color-3").getAttribute("data-taken")).toBeNull();
    });

    it("counts hidden repos as holders", () => {
      useRepoStore.setState({
        repos: [repo, { ...other("https://github.com/owner/b.git", 9), hidden: true }],
      });
      render(<RepoColorPicker />);
      expect(screen.getByTestId("repo-color-9").getAttribute("data-taken")).toBe("true");
    });

    /*
      The colour belongs to ONE repository and the settings value record is
      keyed by setting alone, so this row reads the repositories store for the
      repository the dialog was opened for (slice 7). Reading the wrong one
      would show — and overwrite — another repository's colour.
    */
    it("selects and writes the colour of the repository the dialog is open for", async () => {
      const b = other("https://github.com/owner/b.git", 9);
      useRepoStore.setState({ repos: [repo, b], setRepoColorIndex });
      useUiStore.getState().setProjectSettingsRepoUrl(b.url);

      render(<RepoColorPicker />);
      expect(screen.getByTestId("repo-color-9").getAttribute("aria-checked")).toBe("true");
      expect(screen.getByTestId("repo-color-3").getAttribute("aria-checked")).toBe("false");

      await userEvent.click(screen.getByTestId("repo-color-5"));
      expect(setRepoColorIndex).toHaveBeenCalledWith(b.url, 5);
    });

    it("still allows picking a taken color", async () => {
      useRepoStore.setState({ repos: [repo, other("https://github.com/owner/b.git", 9)], setRepoColorIndex });
      render(<RepoColorPicker />);
      await userEvent.click(screen.getByTestId("repo-color-9"));
      expect(setRepoColorIndex).toHaveBeenCalledWith(url, 9);
    });
  });
});
