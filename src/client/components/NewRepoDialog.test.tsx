import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewRepoDialog } from "./NewRepoDialog.js";
import type { TemplateInfo } from "../utils/template-info.js";

afterEach(cleanup);

const makeTemplate = (overrides: Partial<TemplateInfo> = {}): TemplateInfo => ({
  id: "react",
  name: "React",
  description: "React starter",
  category: "frontend",
  icon: "react",
  ...overrides,
});

const sampleTemplates: TemplateInfo[] = [
  makeTemplate({ id: "react", name: "React", description: "React starter", category: "frontend", icon: "react" }),
  makeTemplate({ id: "vue", name: "Vue", description: "Vue starter", category: "frontend", icon: "vue" }),
  makeTemplate({ id: "nextjs", name: "Next.js", description: "Next.js full-stack", category: "fullstack", icon: "nextjs" }),
  makeTemplate({ id: "express", name: "Express", description: "Express API", category: "backend", icon: "express" }),
  makeTemplate({ id: "node", name: "Node Script", description: "Node utility", category: "utility", icon: "node" }),
];

const defaultProps = {
  username: "testuser",
  templates: sampleTemplates,
  onSubmit: vi.fn(),
  onClose: vi.fn(),
  creating: false,
};

describe("NewRepoDialog", () => {
  it("renders dialog with name input, description, and template grid", () => {
    render(<NewRepoDialog {...defaultProps} />);

    expect(screen.getByText("Create New Repository")).toBeTruthy();
    expect(screen.getByPlaceholderText("my-project")).toBeTruthy();
    expect(screen.getByPlaceholderText("A short description of the project")).toBeTruthy();
    expect(screen.getByText("Project template")).toBeTruthy();
    // Templates are rendered
    expect(screen.getByText("React")).toBeTruthy();
    expect(screen.getByText("Vue")).toBeTruthy();
    expect(screen.getByText("Next.js")).toBeTruthy();
    expect(screen.getByText("Express")).toBeTruthy();
    expect(screen.getByText("Node Script")).toBeTruthy();
  });

  it("shows username in the description text", () => {
    render(<NewRepoDialog {...defaultProps} username="alice" />);
    expect(screen.getByText("alice")).toBeTruthy();
  });

  it("validates repo name format and shows error for special characters", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const nameInput = screen.getByPlaceholderText("my-project");

    // Type a name with spaces (invalid)
    fireEvent.change(nameInput, { target: { value: "my project" } });
    expect(screen.getByText("Only letters, numbers, hyphens, dots, and underscores allowed.")).toBeTruthy();

    // Type a name with special chars
    fireEvent.change(nameInput, { target: { value: "repo@name!" } });
    expect(screen.getByText("Only letters, numbers, hyphens, dots, and underscores allowed.")).toBeTruthy();

    // Type a valid name, error should disappear
    fireEvent.change(nameInput, { target: { value: "my-valid-repo" } });
    expect(screen.queryByText("Only letters, numbers, hyphens, dots, and underscores allowed.")).toBeNull();
  });

  it("does not show validation error when name is empty", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const nameInput = screen.getByPlaceholderText("my-project");
    fireEvent.change(nameInput, { target: { value: "" } });
    expect(screen.queryByText("Only letters, numbers, hyphens, dots, and underscores allowed.")).toBeNull();
  });

  it("submit button is disabled when name is empty", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const submitBtn = screen.getByText("Create & Setup");
    expect(submitBtn).toBeDisabled();
  });

  it("submit button is disabled when no template is selected", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const nameInput = screen.getByPlaceholderText("my-project");
    fireEvent.change(nameInput, { target: { value: "valid-name" } });

    const submitBtn = screen.getByText("Create & Setup");
    expect(submitBtn).toBeDisabled();
  });

  it("submit button is enabled when name is valid and template is selected", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const nameInput = screen.getByPlaceholderText("my-project");
    fireEvent.change(nameInput, { target: { value: "valid-name" } });

    // Select a template
    fireEvent.click(screen.getByText("React"));

    const submitBtn = screen.getByText("Create & Setup");
    expect(submitBtn).not.toBeDisabled();
  });

  it("submit button is disabled when name has invalid characters", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const nameInput = screen.getByPlaceholderText("my-project");
    fireEvent.change(nameInput, { target: { value: "bad name!" } });
    fireEvent.click(screen.getByText("React"));

    const submitBtn = screen.getByText("Create & Setup");
    expect(submitBtn).toBeDisabled();
  });

  it("selecting a template highlights it with border-(--color-accent)", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const reactBtn = screen.getByText("React").closest("button")!;
    expect(reactBtn.className).toContain("border-(--color-border-secondary)");
    expect(reactBtn.className).not.toContain("border-(--color-accent)");

    fireEvent.click(reactBtn);
    expect(reactBtn.className).toContain("border-(--color-accent)");
  });

  it("selecting a different template un-highlights the previous one", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const reactBtn = screen.getByText("React").closest("button")!;
    const vueBtn = screen.getByText("Vue").closest("button")!;

    fireEvent.click(reactBtn);
    expect(reactBtn.className).toContain("border-(--color-accent)");

    fireEvent.click(vueBtn);
    expect(reactBtn.className).not.toContain("border-(--color-accent)");
    expect(vueBtn.className).toContain("border-(--color-accent)");
  });

  it("category filter pills filter the template list", () => {
    render(<NewRepoDialog {...defaultProps} />);

    // Helper: get a filter pill button by label (pills are in the flex-wrap container)
    const getFilterPill = (label: string) => {
      const all = screen.getAllByText(label);
      // The pill is the <button> with rounded-full class; the group header is an <h3>
      return all.find((el) => el.tagName === "BUTTON" && el.className.includes("rounded-full"))!;
    };

    // All templates visible initially
    expect(screen.getByText("React")).toBeTruthy();
    expect(screen.getByText("Express")).toBeTruthy();
    expect(screen.getByText("Node Script")).toBeTruthy();

    // Click "Frontend" filter pill
    fireEvent.click(getFilterPill("Frontend"));
    expect(screen.getByText("React")).toBeTruthy();
    expect(screen.getByText("Vue")).toBeTruthy();
    // Backend and utility templates should be hidden
    expect(screen.queryByText("Express")).toBeNull();
    expect(screen.queryByText("Node Script")).toBeNull();

    // Click "Backend" filter pill
    fireEvent.click(getFilterPill("Backend"));
    expect(screen.getByText("Express")).toBeTruthy();
    expect(screen.queryByText("React")).toBeNull();
    expect(screen.queryByText("Node Script")).toBeNull();

    // Click "All" to reset
    fireEvent.click(screen.getByText("All"));
    expect(screen.getByText("React")).toBeTruthy();
    expect(screen.getByText("Express")).toBeTruthy();
    expect(screen.getByText("Node Script")).toBeTruthy();
  });

  it("shows category group headers", () => {
    render(<NewRepoDialog {...defaultProps} />);

    // Group headers are <h3> elements with CSS text-transform: uppercase
    // The actual text content is mixed-case, rendered uppercase by CSS
    const headers = document.querySelectorAll("h3.uppercase");
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toContain("Frontend");
    expect(headerTexts).toContain("Full-Stack");
    expect(headerTexts).toContain("Backend");
    expect(headerTexts).toContain("Utility");
  });

  it("calls onSubmit with correct args when form is submitted", () => {
    const onSubmit = vi.fn();
    render(<NewRepoDialog {...defaultProps} onSubmit={onSubmit} />);

    const nameInput = screen.getByPlaceholderText("my-project");
    const descInput = screen.getByPlaceholderText("A short description of the project");

    fireEvent.change(nameInput, { target: { value: "my-repo" } });
    fireEvent.change(descInput, { target: { value: "A cool project" } });

    // Select template
    fireEvent.click(screen.getByText("Next.js"));

    // Submit
    fireEvent.click(screen.getByText("Create & Setup"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("my-repo", "A cool project", true, "nextjs");
  });

  it("trims name and description before submitting", () => {
    const onSubmit = vi.fn();
    render(<NewRepoDialog {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "  my-repo  " } });
    fireEvent.change(screen.getByPlaceholderText("A short description of the project"), { target: { value: "  desc  " } });
    fireEvent.click(screen.getByText("React"));
    fireEvent.click(screen.getByText("Create & Setup"));

    expect(onSubmit).toHaveBeenCalledWith("my-repo", "desc", true, "react");
  });

  it("submits with isPrivate true when Private is selected", () => {
    const onSubmit = vi.fn();
    render(<NewRepoDialog {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "my-repo" } });
    fireEvent.click(screen.getByText("Private"));
    fireEvent.click(screen.getByText("React"));
    fireEvent.click(screen.getByText("Create & Setup"));

    expect(onSubmit).toHaveBeenCalledWith("my-repo", "", true, "react");
  });

  it("does not call onSubmit when submit button is disabled", () => {
    const onSubmit = vi.fn();
    render(<NewRepoDialog {...defaultProps} onSubmit={onSubmit} />);

    // No name or template selected -- button should be disabled
    fireEvent.click(screen.getByText("Create & Setup"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onClose when Cancel button is clicked", () => {
    const onClose = vi.fn();
    render(<NewRepoDialog {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close (x) button is clicked", () => {
    const onClose = vi.fn();
    render(<NewRepoDialog {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewRepoDialog {...defaultProps} onClose={onClose} />);

    // Radix Dialog handles Escape natively
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows creating state when creating prop is true", () => {
    render(<NewRepoDialog {...defaultProps} creating={true} />);

    expect(screen.getByText("Creating...")).toBeTruthy();
    expect(screen.queryByText("Create & Setup")).toBeNull();

    // Inputs should be disabled
    expect(screen.getByPlaceholderText("my-project")).toBeDisabled();
    expect(screen.getByPlaceholderText("A short description of the project")).toBeDisabled();

    // Cancel button should be disabled
    expect(screen.getByText("Cancel")).toBeDisabled();
  });

  it("submit button is disabled during creating state even with valid input", () => {
    render(<NewRepoDialog {...defaultProps} creating={true} />);

    const submitBtn = screen.getByText("Creating...");
    expect(submitBtn).toBeDisabled();
  });

  it("backdrop click closes dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewRepoDialog {...defaultProps} onClose={onClose} />);

    // Radix Dialog closes via overlay click; test with Escape as a reliable equivalent
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the dialog does not close it", () => {
    const onClose = vi.fn();
    render(<NewRepoDialog {...defaultProps} onClose={onClose} />);

    // Click on the dialog content (not the backdrop)
    fireEvent.click(screen.getByText("Create New Repository"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("allows valid names with dots, hyphens, and underscores", () => {
    render(<NewRepoDialog {...defaultProps} />);

    const nameInput = screen.getByPlaceholderText("my-project");

    fireEvent.change(nameInput, { target: { value: "my.repo_name-2" } });
    expect(screen.queryByText("Only letters, numbers, hyphens, dots, and underscores allowed.")).toBeNull();
  });
});
