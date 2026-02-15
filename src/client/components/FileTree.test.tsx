import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FileTree, type FileTreeNode } from "./FileTree.js";

afterEach(cleanup);

const sampleTree: FileTreeNode[] = [
  {
    name: "src",
    path: "src",
    type: "directory",
    children: [
      {
        name: "components",
        path: "src/components",
        type: "directory",
        children: [
          { name: "App.tsx", path: "src/components/App.tsx", type: "file" },
        ],
      },
      { name: "index.ts", path: "src/index.ts", type: "file" },
    ],
  },
  { name: "package.json", path: "package.json", type: "file" },
  { name: "README.md", path: "README.md", type: "file" },
];

describe("FileTree", () => {
  it("renders empty state when tree is empty", () => {
    render(<FileTree tree={[]} onRefresh={() => {}} />);
    expect(screen.getByText("No files in /workspace yet.")).toBeInTheDocument();
  });

  it("renders a refresh button in empty state", () => {
    const onRefresh = vi.fn();
    render(<FileTree tree={[]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("Refresh"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders the header bar with Reload button", () => {
    const onRefresh = vi.fn();
    render(<FileTree tree={sampleTree} onRefresh={onRefresh} />);
    expect(screen.getByText("Files")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Reload"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders root-level files and directories", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("auto-expands root-level directories (depth 0)", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    // Root-level src directory is auto-expanded (depth 0 < 1)
    expect(screen.getByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("components")).toBeInTheDocument();
  });

  it("does not auto-expand nested directories (depth >= 1)", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    // components dir is at depth 1, should be collapsed by default
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("toggles directory expansion on click", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    // components is collapsed, App.tsx not visible
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText("components"));
    expect(screen.getByText("App.tsx")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText("components"));
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("collapses root directory on click", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    // src is auto-expanded, index.ts visible
    expect(screen.getByText("index.ts")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText("src"));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
  });

  it("renders SVG icons for files and directories", () => {
    const { container } = render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    const svgs = container.querySelectorAll("svg");
    // At minimum: chevron + folder for src, chevron + folder for components,
    // file icon for index.ts, file icons for package.json and README.md
    expect(svgs.length).toBeGreaterThanOrEqual(5);
  });

  it("renders a single file correctly", () => {
    const tree: FileTreeNode[] = [
      { name: "hello.txt", path: "hello.txt", type: "file" },
    ];
    render(<FileTree tree={tree} onRefresh={() => {}} />);
    expect(screen.getByText("hello.txt")).toBeInTheDocument();
  });
});
