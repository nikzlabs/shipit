import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LocalModeBanner } from "./LocalModeBanner.js";
import { useUiStore } from "../stores/ui-store.js";

const DISMISS_KEY = "shipit:local-mode-banner-dismissed";

beforeEach(() => {
  localStorage.clear();
  useUiStore.getState().setRuntimeMode("containerized");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  useUiStore.getState().setRuntimeMode("containerized");
});

describe("LocalModeBanner", () => {
  it("renders nothing in containerized mode", () => {
    useUiStore.getState().setRuntimeMode("containerized");
    const { container } = render(<LocalModeBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the banner in local mode", () => {
    useUiStore.getState().setRuntimeMode("local");
    render(<LocalModeBanner />);
    expect(screen.getByTestId("local-mode-banner")).toBeInTheDocument();
    expect(screen.getByText(/Running in local mode/)).toBeInTheDocument();
  });

  it("hides the banner after dismissal and persists the choice", () => {
    useUiStore.getState().setRuntimeMode("local");
    render(<LocalModeBanner />);
    fireEvent.click(screen.getByLabelText("Dismiss local mode notice"));
    expect(screen.queryByTestId("local-mode-banner")).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("stays dismissed across remounts when localStorage records it", () => {
    localStorage.setItem(DISMISS_KEY, "1");
    useUiStore.getState().setRuntimeMode("local");
    const { container } = render(<LocalModeBanner />);
    expect(container.innerHTML).toBe("");
  });
});
