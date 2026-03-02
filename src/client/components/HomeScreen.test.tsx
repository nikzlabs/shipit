import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HomeScreen } from "./HomeScreen.js";

afterEach(cleanup);

describe("HomeScreen", () => {
  describe("zero repos", () => {
    it("renders add-repo prompt and button", () => {
      render(<HomeScreen onAddRepo={vi.fn()} hasRepos={false} />);
      expect(screen.getByText("Add a repository to get started")).toBeTruthy();
      expect(screen.getByText("Add Repository")).toBeTruthy();
    });

    it("calls onAddRepo when button is clicked", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen onAddRepo={onAddRepo} hasRepos={false} />);
      fireEvent.click(screen.getByText("Add Repository"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
    });
  });

  describe("has repos", () => {
    it("renders getting-started instructions", () => {
      render(<HomeScreen onAddRepo={vi.fn()} hasRepos={true} />);
      expect(screen.getByText("Welcome to ShipIt")).toBeTruthy();
      expect(screen.getByText(/\+ New Session/)).toBeTruthy();
    });

    it("renders add-another-repo link", () => {
      const onAddRepo = vi.fn();
      render(<HomeScreen onAddRepo={onAddRepo} hasRepos={true} />);
      fireEvent.click(screen.getByText("+ Add another repository"));
      expect(onAddRepo).toHaveBeenCalledTimes(1);
    });
  });
});
