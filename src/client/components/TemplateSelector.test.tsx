import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TemplateSelector, type TemplateInfo } from "./TemplateSelector.js";

function makeTemplate(overrides?: Partial<TemplateInfo>): TemplateInfo {
  return {
    id: "react-vite-ts",
    name: "React + Vite",
    description: "React 19 SPA with TypeScript",
    category: "frontend",
    icon: "react",
    ...overrides,
  };
}

const ALL_TEMPLATES: TemplateInfo[] = [
  makeTemplate({ id: "react-vite-ts", name: "React + Vite", category: "frontend" }),
  makeTemplate({ id: "vue-vite-ts", name: "Vue + Vite", category: "frontend", icon: "vue" }),
  makeTemplate({ id: "nextjs", name: "Next.js", category: "fullstack", icon: "nextjs" }),
  makeTemplate({ id: "express-ts", name: "Express API", category: "backend", icon: "express" }),
  makeTemplate({ id: "node-cli-ts", name: "Node.js CLI", category: "utility", icon: "node" }),
];

describe("TemplateSelector", () => {
  const defaultProps = () => ({
    templates: ALL_TEMPLATES,
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
    applying: false,
  });

  afterEach(cleanup);

  describe("rendering", () => {
    it("renders the heading and description", () => {
      render(<TemplateSelector {...defaultProps()} />);
      expect(screen.getByText("Start with a template")).toBeInTheDocument();
      expect(screen.getByText(/Choose a project template/)).toBeInTheDocument();
    });

    it("renders all template names", () => {
      render(<TemplateSelector {...defaultProps()} />);
      expect(screen.getByText("React + Vite")).toBeInTheDocument();
      expect(screen.getByText("Vue + Vite")).toBeInTheDocument();
      expect(screen.getByText("Next.js")).toBeInTheDocument();
      expect(screen.getByText("Express API")).toBeInTheDocument();
      expect(screen.getByText("Node.js CLI")).toBeInTheDocument();
    });

    it("renders category group headings", () => {
      render(<TemplateSelector {...defaultProps()} />);
      // Category headings are h3 elements (filter pills are buttons with same text)
      const headings = screen.getAllByRole("heading", { level: 3 });
      const headingTexts = headings.map((h) => h.textContent);
      expect(headingTexts).toContain("Frontend");
      expect(headingTexts).toContain("Full-Stack");
      expect(headingTexts).toContain("Backend");
      expect(headingTexts).toContain("Utility");
    });

    it("renders the dismiss link", () => {
      render(<TemplateSelector {...defaultProps()} />);
      expect(screen.getByText(/Skip/)).toBeInTheDocument();
    });

    it("renders filter pills", () => {
      render(<TemplateSelector {...defaultProps()} />);
      expect(screen.getByText("All")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("calls onSelect when a template card is clicked", () => {
      const props = defaultProps();
      render(<TemplateSelector {...props} />);
      fireEvent.click(screen.getByText("React + Vite"));
      expect(props.onSelect).toHaveBeenCalledWith("react-vite-ts");
    });

    it("calls onSelect with correct ID for different templates", () => {
      const props = defaultProps();
      render(<TemplateSelector {...props} />);
      fireEvent.click(screen.getByText("Express API"));
      expect(props.onSelect).toHaveBeenCalledWith("express-ts");
    });

    it("calls onDismiss when skip link is clicked", () => {
      const props = defaultProps();
      render(<TemplateSelector {...props} />);
      fireEvent.click(screen.getByText(/Skip/));
      expect(props.onDismiss).toHaveBeenCalledOnce();
    });
  });

  describe("category filtering", () => {
    it("shows all templates by default", () => {
      render(<TemplateSelector {...defaultProps()} />);
      expect(screen.getByText("React + Vite")).toBeInTheDocument();
      expect(screen.getByText("Express API")).toBeInTheDocument();
      expect(screen.getByText("Node.js CLI")).toBeInTheDocument();
    });

    it("filters to show only frontend templates", () => {
      render(<TemplateSelector {...defaultProps()} />);
      // Click the "Frontend" filter pill (not the heading)
      const pills = screen.getAllByText("Frontend");
      fireEvent.click(pills[0]); // pill button comes first in DOM
      expect(screen.getByText("React + Vite")).toBeInTheDocument();
      expect(screen.getByText("Vue + Vite")).toBeInTheDocument();
      expect(screen.queryByText("Express API")).not.toBeInTheDocument();
      expect(screen.queryByText("Node.js CLI")).not.toBeInTheDocument();
    });

    it("filters to show only backend templates", () => {
      render(<TemplateSelector {...defaultProps()} />);
      const pills = screen.getAllByText("Backend");
      fireEvent.click(pills[0]);
      expect(screen.getByText("Express API")).toBeInTheDocument();
      expect(screen.queryByText("React + Vite")).not.toBeInTheDocument();
    });

    it("returns to all templates when All is clicked", () => {
      render(<TemplateSelector {...defaultProps()} />);
      const backendPills = screen.getAllByText("Backend");
      fireEvent.click(backendPills[0]);
      expect(screen.queryByText("React + Vite")).not.toBeInTheDocument();

      fireEvent.click(screen.getByText("All"));
      expect(screen.getByText("React + Vite")).toBeInTheDocument();
      expect(screen.getByText("Express API")).toBeInTheDocument();
    });
  });

  describe("applying state", () => {
    it("shows applying indicator when applying is true", () => {
      const props = defaultProps();
      props.applying = true;
      render(<TemplateSelector {...props} />);
      expect(screen.getByText("Setting up project...")).toBeInTheDocument();
    });

    it("hides template cards when applying", () => {
      const props = defaultProps();
      props.applying = true;
      render(<TemplateSelector {...props} />);
      expect(screen.queryByText("React + Vite")).not.toBeInTheDocument();
      expect(screen.queryByText("Express API")).not.toBeInTheDocument();
    });

    it("hides dismiss link when applying", () => {
      const props = defaultProps();
      props.applying = true;
      render(<TemplateSelector {...props} />);
      expect(screen.queryByText(/Skip/)).not.toBeInTheDocument();
    });
  });

  describe("empty templates", () => {
    it("renders without error when templates list is empty", () => {
      const props = defaultProps();
      props.templates = [];
      render(<TemplateSelector {...props} />);
      expect(screen.getByText("Start with a template")).toBeInTheDocument();
      expect(screen.getByText(/Skip/)).toBeInTheDocument();
    });
  });
});
