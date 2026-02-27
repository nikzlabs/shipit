import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { GitHubTokenForm } from "./GitHubTokenForm.js";

afterEach(cleanup);

function renderForm(overrides: Partial<Parameters<typeof GitHubTokenForm>[0]> = {}) {
  const defaults = {
    onSubmit: vi.fn().mockResolvedValue(true),
  };
  return { ...defaults, ...overrides, result: render(<GitHubTokenForm {...defaults} {...overrides} />) };
}

describe("GitHubTokenForm", () => {
  it("renders token input and connect button", () => {
    renderForm();
    expect(screen.getByTestId("github-token-input")).toBeInTheDocument();
    expect(screen.getByTestId("github-token-submit")).toHaveTextContent("Connect");
  });

  it("submit button disabled when input empty", () => {
    renderForm();
    expect(screen.getByTestId("github-token-submit")).toBeDisabled();
  });

  it("submit button enabled when input has value", () => {
    renderForm();
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_test" } });
    expect(screen.getByTestId("github-token-submit")).not.toBeDisabled();
  });

  it("calls onSubmit with trimmed token on click", () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "  ghp_test  " } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    expect(onSubmit).toHaveBeenCalledWith("ghp_test");
  });

  it("calls onSubmit on Enter key", () => {
    const { onSubmit } = renderForm();
    const input = screen.getByTestId("github-token-input");
    fireEvent.change(input, { target: { value: "ghp_enter" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("ghp_enter");
  });

  it("shows Connecting... while loading", async () => {
    let resolveSubmit!: (value: boolean) => void;
    const onSubmit = vi.fn().mockReturnValue(new Promise<boolean>((r) => { resolveSubmit = r; }));
    renderForm({ onSubmit });
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_test" } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    expect(screen.getByTestId("github-token-submit")).toHaveTextContent("Connecting...");
    expect(screen.getByTestId("github-token-input")).toBeDisabled();
    resolveSubmit(true);
    await waitFor(() => expect(screen.getByTestId("github-token-submit")).toHaveTextContent("Connect"));
  });

  it("shows error when onSubmit returns false", async () => {
    const { onSubmit } = renderForm();
    (onSubmit as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => expect(screen.getByTestId("github-token-error")).toBeInTheDocument());
  });

  it("shows error when onSubmit throws", async () => {
    const { onSubmit } = renderForm();
    (onSubmit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => expect(screen.getByTestId("github-token-error")).toHaveTextContent("Failed to connect"));
  });

  it("clears error on input change", async () => {
    const { onSubmit } = renderForm();
    (onSubmit as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => expect(screen.getByTestId("github-token-error")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_new" } });
    expect(screen.queryByTestId("github-token-error")).not.toBeInTheDocument();
  });

  it("shows help link to GitHub settings", () => {
    renderForm();
    const link = screen.getByText("classic Personal Access Token");
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens/new");
  });
});
