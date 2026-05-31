import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AuthOverlay } from "./AuthOverlay.js";

afterEach(cleanup);

describe("AuthOverlay", () => {
  it("shows auth link when URL is provided", () => {
    render(<AuthOverlay url="https://console.anthropic.com/auth" />);

    expect(screen.getByText("Authentication Required")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open Authentication Page" });
    expect(link).toHaveAttribute("href", "https://console.anthropic.com/auth");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows code input when URL is provided", () => {
    render(<AuthOverlay url="https://console.anthropic.com/auth" />);

    expect(screen.getByLabelText(/paste the authorization code/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit Code" })).toBeInTheDocument();
  });

  it("shows spinner when URL is empty", () => {
    render(<AuthOverlay url="" />);

    expect(screen.getByText("Authentication Required")).toBeInTheDocument();
    expect(screen.getByText("Waiting for authentication URL...")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Authentication Page" })).not.toBeInTheDocument();
  });

  it("validates empty auth code", () => {
    render(<AuthOverlay url="https://example.com/auth" />);

    fireEvent.click(screen.getByRole("button", { name: "Submit Code" }));
    expect(screen.getByText("Authorization code cannot be empty")).toBeInTheDocument();
  });

  it("calls onPasteCode with valid code", () => {
    const onPasteCode = vi.fn();
    render(<AuthOverlay url="https://example.com/auth" onPasteCode={onPasteCode} />);

    fireEvent.change(screen.getByPlaceholderText("Paste code here..."), { target: { value: "my-auth-code-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Code" }));
    expect(onPasteCode).toHaveBeenCalledWith("my-auth-code-123");
  });

  it("disables submit button after code is submitted", () => {
    const onPasteCode = vi.fn();
    render(<AuthOverlay url="https://example.com/auth" onPasteCode={onPasteCode} />);

    fireEvent.change(screen.getByPlaceholderText("Paste code here..."), { target: { value: "my-auth-code-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Code" }));

    const button = screen.getByRole("button", { name: /waiting/i });
    expect(button).toBeDisabled();
    expect(screen.getByPlaceholderText("Paste code here...")).toBeDisabled();
  });

  it("shows 'Use API key instead' link", () => {
    render(<AuthOverlay url="" />);

    expect(screen.getByText("Use API key instead")).toBeInTheDocument();
    expect(screen.queryByLabelText("Enter your Anthropic API key")).not.toBeInTheDocument();
  });

  it("shows API key form when link is clicked", () => {
    render(<AuthOverlay url="" />);

    fireEvent.click(screen.getByText("Use API key instead"));
    expect(screen.getByLabelText("Enter your Anthropic API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Authenticate" })).toBeInTheDocument();
  });

  it("validates empty API key", () => {
    render(<AuthOverlay url="" />);

    fireEvent.click(screen.getByText("Use API key instead"));
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }));
    expect(screen.getByText("API key cannot be empty")).toBeInTheDocument();
  });

  it("validates API key format", () => {
    render(<AuthOverlay url="" />);

    fireEvent.click(screen.getByText("Use API key instead"));
    fireEvent.change(screen.getByPlaceholderText("sk-ant-..."), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }));
    expect(screen.getByText("Invalid API key format")).toBeInTheDocument();
  });

  it("calls onApiKey with valid key", () => {
    const onApiKey = vi.fn();
    render(<AuthOverlay url="" onApiKey={onApiKey} />);

    fireEvent.click(screen.getByText("Use API key instead"));
    fireEvent.change(screen.getByPlaceholderText("sk-ant-..."), { target: { value: "sk-ant-test123" } });
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }));
    expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123");
  });

  it("does not render a dismiss button when onDismiss is not provided", () => {
    render(<AuthOverlay url="https://example.com/auth" />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("calls onDismiss when the close button is clicked", () => {
    const onDismiss = vi.fn();
    render(<AuthOverlay url="https://example.com/auth" onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when Escape is pressed", () => {
    const onDismiss = vi.fn();
    render(<AuthOverlay url="https://example.com/auth" onDismiss={onDismiss} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when the backdrop is clicked", () => {
    const onDismiss = vi.fn();
    render(<AuthOverlay url="https://example.com/auth" onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
