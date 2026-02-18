import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ImportRepoOverlay, type ImportRepoOverlayProps } from "./ImportRepoOverlay.js";

afterEach(cleanup);

const defaultProps: ImportRepoOverlayProps = {
  onSearch: vi.fn(),
  onImport: vi.fn(),
  onClose: vi.fn(),
  searchResults: [],
  progress: null,
  importing: false,
};

describe("ImportRepoOverlay", () => {
  it("renders search input", () => {
    render(<ImportRepoOverlay {...defaultProps} />);
    expect(screen.getByPlaceholderText("Search repos or paste URL...")).toBeTruthy();
  });

  it("renders Import and Cancel buttons", () => {
    render(<ImportRepoOverlay {...defaultProps} />);
    expect(screen.getByText("Import")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<ImportRepoOverlay {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onImport with URL when Import is clicked", () => {
    const onImport = vi.fn();
    render(<ImportRepoOverlay {...defaultProps} onImport={onImport} />);

    const input = screen.getByPlaceholderText("Search repos or paste URL...");
    fireEvent.change(input, { target: { value: "https://github.com/owner/repo.git" } });
    fireEvent.click(screen.getByText("Import"));

    expect(onImport).toHaveBeenCalledWith("https://github.com/owner/repo.git", undefined);
  });

  it("disables Import button when input is empty", () => {
    render(<ImportRepoOverlay {...defaultProps} />);
    const importBtn = screen.getByText("Import");
    expect(importBtn.hasAttribute("disabled")).toBe(true);
  });

  it("shows search results", () => {
    const results = [
      {
        fullName: "acme/web-app",
        description: "A web application",
        private: false,
        defaultBranch: "main",
        cloneUrl: "https://github.com/acme/web-app.git",
      },
    ];
    render(<ImportRepoOverlay {...defaultProps} searchResults={results} />);

    // Type something first to show results
    const input = screen.getByPlaceholderText("Search repos or paste URL...");
    fireEvent.change(input, { target: { value: "acme" } });

    expect(screen.getByText("acme/web-app")).toBeTruthy();
    expect(screen.getByText("A web application")).toBeTruthy();
  });

  it("selects repo and populates URL", () => {
    const results = [
      {
        fullName: "acme/web-app",
        description: "A web application",
        private: false,
        defaultBranch: "develop",
        cloneUrl: "https://github.com/acme/web-app.git",
      },
    ];
    render(<ImportRepoOverlay {...defaultProps} searchResults={results} />);

    // Type to show results
    const input = screen.getByPlaceholderText("Search repos or paste URL...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "acme" } });

    // Click the repo
    fireEvent.click(screen.getByText("acme/web-app"));

    // Input should now have the clone URL
    expect(input.value).toBe("https://github.com/acme/web-app.git");
  });

  it("shows progress when importing", () => {
    render(
      <ImportRepoOverlay
        {...defaultProps}
        importing={true}
        progress={{ stage: "cloning", message: "Cloning repository..." }}
      />,
    );
    expect(screen.getByText("Cloning repository...")).toBeTruthy();
    expect(screen.getByText("Importing...")).toBeTruthy();
  });

  it("shows private badge for private repos", () => {
    const results = [
      {
        fullName: "acme/secret",
        description: null,
        private: true,
        defaultBranch: "main",
        cloneUrl: "https://github.com/acme/secret.git",
      },
    ];
    render(<ImportRepoOverlay {...defaultProps} searchResults={results} />);
    const input = screen.getByPlaceholderText("Search repos or paste URL...");
    fireEvent.change(input, { target: { value: "acme" } });
    expect(screen.getByText("private")).toBeTruthy();
  });
});
