import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HomeScreen } from "./HomeScreen.js";

afterEach(cleanup);

const baseProps = {
  onAddRepo: vi.fn(),
  githubAuthenticated: true,
  hasRepos: false,
};

describe("HomeScreen", () => {
  describe("zero repos, GitHub connected", () => {
    it("leads with Add Repository and offers no sandbox on-ramp", () => {
      render(<HomeScreen {...baseProps} githubAuthenticated={true} hasRepos={false} />);
      expect(screen.getByText("Add Repository")).toBeTruthy();
      expect(screen.queryByText("Start a sandbox session")).toBeNull();
    });

    it("calls onAddRepo when Add Repository is clicked", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen {...baseProps} onAddRepo={onAddRepo} githubAuthenticated={true} hasRepos={false} />);
      fireEvent.click(screen.getByText("Add Repository"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
    });
  });

  describe("zero repos, GitHub NOT connected (manual identity)", () => {
    it("leads with the Connect-GitHub on-ramp and offers no sandbox", () => {
      render(<HomeScreen {...baseProps} githubAuthenticated={false} hasRepos={false} />);
      expect(screen.getByText("Connect GitHub to add repositories")).toBeTruthy();
      expect(screen.queryByText("Start a sandbox session")).toBeNull();
      // The bare "Add Repository" CTA (which would dead-end) is not the path here.
      expect(screen.queryByText("Add Repository")).toBeNull();
    });

    it("routes the primary action through onAddRepo (which opens the Connect-GitHub prompt)", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen {...baseProps} onAddRepo={onAddRepo} githubAuthenticated={false} hasRepos={false} />);
      fireEvent.click(screen.getByText("Connect GitHub to add repositories"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
    });
  });

  describe("has repos", () => {
    it("renders getting-started instructions", () => {
      render(<HomeScreen {...baseProps} hasRepos={true} />);
      expect(screen.getByText("Welcome to ShipIt")).toBeTruthy();
      expect(screen.getByText(/\+ New Session/)).toBeTruthy();
    });

    it("renders an add-another-repo link and no sandbox link", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen {...baseProps} onAddRepo={onAddRepo} hasRepos={true} />);
      fireEvent.click(screen.getByText("+ Add another repository"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Sandbox session")).toBeNull();
    });
  });
});
