import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HomeScreen } from "./HomeScreen.js";

afterEach(cleanup);

const baseProps = {
  onAddRepo: vi.fn(),
  onCreateSandbox: vi.fn(),
  githubAuthenticated: true,
  hasRepos: false,
};

describe("HomeScreen", () => {
  describe("zero repos, GitHub connected", () => {
    it("leads with Add Repository and offers a sandbox alternative", () => {
      render(<HomeScreen {...baseProps} githubAuthenticated={true} hasRepos={false} />);
      expect(screen.getByText("Add Repository")).toBeTruthy();
      expect(screen.getByText("Start a sandbox session")).toBeTruthy();
    });

    it("calls onAddRepo when Add Repository is clicked", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen {...baseProps} onAddRepo={onAddRepo} githubAuthenticated={true} hasRepos={false} />);
      fireEvent.click(screen.getByText("Add Repository"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
    });

    it("calls onCreateSandbox when the sandbox button is clicked", () => {
      const onCreateSandbox = vi.fn();
      render(<HomeScreen {...baseProps} onCreateSandbox={onCreateSandbox} githubAuthenticated={true} hasRepos={false} />);
      fireEvent.click(screen.getByText("Start a sandbox session"));
      expect(onCreateSandbox).toHaveBeenCalledTimes(1);
    });
  });

  describe("zero repos, GitHub NOT connected (manual identity)", () => {
    it("leads with the sandbox on-ramp and offers Connect GitHub as secondary", () => {
      render(<HomeScreen {...baseProps} githubAuthenticated={false} hasRepos={false} />);
      expect(screen.getByText("Start a sandbox session")).toBeTruthy();
      expect(screen.getByText("Connect GitHub to add repositories")).toBeTruthy();
      // The bare "Add Repository" CTA (which would dead-end) is not the primary path here.
      expect(screen.queryByText("Add Repository")).toBeNull();
    });

    it("routes the secondary action through onAddRepo (which opens the Connect-GitHub prompt)", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen {...baseProps} onAddRepo={onAddRepo} githubAuthenticated={false} hasRepos={false} />);
      fireEvent.click(screen.getByText("Connect GitHub to add repositories"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
    });

    it("starts a sandbox without requiring GitHub", () => {
      const onCreateSandbox = vi.fn();
      render(<HomeScreen {...baseProps} onCreateSandbox={onCreateSandbox} githubAuthenticated={false} hasRepos={false} />);
      fireEvent.click(screen.getByText("Start a sandbox session"));
      expect(onCreateSandbox).toHaveBeenCalledTimes(1);
    });
  });

  describe("has repos", () => {
    it("renders getting-started instructions", () => {
      render(<HomeScreen {...baseProps} hasRepos={true} />);
      expect(screen.getByText("Welcome to ShipIt")).toBeTruthy();
      expect(screen.getByText(/\+ New Session/)).toBeTruthy();
    });

    it("renders add-another-repo and sandbox links", () => {
      const onAddRepo = vi.fn();
      const onCreateSandbox = vi.fn();
      render(<HomeScreen {...baseProps} onAddRepo={onAddRepo} onCreateSandbox={onCreateSandbox} hasRepos={true} />);
      fireEvent.click(screen.getByText("+ Add another repository"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText("Sandbox session"));
      expect(onCreateSandbox).toHaveBeenCalledTimes(1);
    });
  });
});
