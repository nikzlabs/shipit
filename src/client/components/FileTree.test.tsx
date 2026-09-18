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
    fireEvent.click(screen.getByTitle("Refresh file tree"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders root-level files and directories", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("does not auto-expand root-level directories (everything collapsed)", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("components")).not.toBeInTheDocument();
  });

  it("does not auto-expand nested directories", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("toggles directory expansion on click", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    fireEvent.click(screen.getByText("src"));
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("components"));
    expect(screen.getByText("App.tsx")).toBeInTheDocument();

    fireEvent.click(screen.getByText("components"));
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("expands root directory on click", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("src"));
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("renders SVG icons for files and directories", () => {
    const { container } = render(<FileTree tree={sampleTree} onRefresh={() => {}} />);
    fireEvent.click(screen.getByText("src"));
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(5);
  });

  it("renders a single file correctly", () => {
    const tree: FileTreeNode[] = [
      { name: "hello.txt", path: "hello.txt", type: "file" },
    ];
    render(<FileTree tree={tree} onRefresh={() => {}} />);
    expect(screen.getByText("hello.txt")).toBeInTheDocument();
  });

  it("calls onFileClick when a file is clicked", () => {
    const onFileClick = vi.fn();
    render(<FileTree tree={sampleTree} onRefresh={() => {}} onFileClick={onFileClick} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("index.ts"));
    expect(onFileClick).toHaveBeenCalledWith("src/index.ts");
  });

  it("calls onFileClick for root-level files", () => {
    const onFileClick = vi.fn();
    render(<FileTree tree={sampleTree} onRefresh={() => {}} onFileClick={onFileClick} />);
    fireEvent.click(screen.getByText("package.json"));
    expect(onFileClick).toHaveBeenCalledWith("package.json");
  });

  it("calls onEdit when a file edit button is clicked", () => {
    const onEdit = vi.fn();
    render(<FileTree tree={sampleTree} onRefresh={() => {}} onEdit={onEdit} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByLabelText("Edit index.ts"));
    expect(onEdit).toHaveBeenCalledWith("src/index.ts");
  });

  it("does not render edit buttons for uploads", () => {
    const uploads = [
      { id: "1", name: "data.csv", status: "ready" as const, path: "/uploads/data.csv", size: 100, progress: 100 },
    ];
    render(<FileTree tree={sampleTree} onRefresh={() => {}} uploads={uploads} onEdit={() => {}} />);
    expect(screen.queryByLabelText("Edit data.csv")).not.toBeInTheDocument();
  });

  it("highlights selected file", () => {
    render(
      <FileTree tree={sampleTree} onRefresh={() => {}} selectedFile="src/index.ts" />
    );
    fireEvent.click(screen.getByText("src"));
    const fileRow = screen.getByText("index.ts").closest("div[draggable]") ?? screen.getByText("index.ts").closest("button")?.parentElement;
    expect(fileRow?.className).toContain("bg-(--color-accent-subtle)");
  });

  it("does not highlight non-selected files", () => {
    render(
      <FileTree tree={sampleTree} onRefresh={() => {}} selectedFile="src/index.ts" />
    );
    const fileButton = screen.getByText("package.json").closest("button");
    expect(fileButton?.className).not.toContain("bg-(--color-accent-subtle)");
  });

  it("renders files as buttons for clickability", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} onFileClick={() => {}} />);
    fireEvent.click(screen.getByText("src"));
    const fileButton = screen.getByText("index.ts").closest("button");
    expect(fileButton).not.toBeNull();
  });

  it("renders an Uploads section when uploads are provided", () => {
    const uploads = [
      { id: "1", name: "data.csv", status: "ready" as const, path: "/uploads/data.csv", size: 100, progress: 100 },
      { id: "2", name: "photo.png", status: "ready" as const, path: "/uploads/photo.png", size: 500, progress: 100 },
    ];
    render(<FileTree tree={sampleTree} onRefresh={() => {}} uploads={uploads} />);
    expect(screen.getByText("Uploads")).toBeInTheDocument();
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("does not render Uploads section when no uploads", () => {
    render(<FileTree tree={sampleTree} onRefresh={() => {}} uploads={[]} />);
    expect(screen.queryByText("Uploads")).not.toBeInTheDocument();
  });

  it("calls onFileClick when an upload filename is clicked", () => {
    const onFileClick = vi.fn();
    const uploads = [
      { id: "1", name: "data.csv", status: "ready" as const, path: "/uploads/data.csv", size: 100, progress: 100 },
    ];
    render(<FileTree tree={sampleTree} onRefresh={() => {}} uploads={uploads} onFileClick={onFileClick} />);
    fireEvent.click(screen.getByText("data.csv"));
    expect(onFileClick).toHaveBeenCalledWith("/uploads/data.csv");
  });

  it("calls onAddToChat with upload path when upload plus button is clicked", () => {
    const onAddToChat = vi.fn();
    const uploads = [
      { id: "1", name: "data.csv", status: "ready" as const, path: "/uploads/data.csv", size: 100, progress: 100 },
    ];
    render(<FileTree tree={sampleTree} onRefresh={() => {}} uploads={uploads} onAddToChat={onAddToChat} />);
    fireEvent.click(screen.getByLabelText("Add data.csv to chat"));
    expect(onAddToChat).toHaveBeenCalledWith("/uploads/data.csv");
  });

  it("keeps rows compact and lets hover action buttons overflow (-my-1) instead of growing the row", () => {
    const uploads = [
      { id: "1", name: "data.csv", status: "ready" as const, path: "/uploads/data.csv", size: 100, progress: 100 },
    ];
    render(<FileTree tree={sampleTree} onRefresh={() => {}} uploads={uploads} onEdit={() => {}} onDownload={() => {}} onAddToChat={() => {}} onDeleteUpload={() => {}} />);

    fireEvent.click(screen.getByText("src"));
    const fileRow = screen.getByText("index.ts").closest("div[draggable]");
    expect(fileRow?.className).not.toContain("min-h-7");
    const folderRow = screen.getByText("src").closest("button");
    expect(folderRow?.className).not.toContain("min-h-7");
    const uploadRow = screen.getByText("data.csv").closest("button")?.parentElement;
    expect(uploadRow?.className).not.toContain("min-h-7");

    for (const label of ["Edit index.ts", "Download index.ts", "Add index.ts to chat", "Add data.csv to chat", "Delete data.csv"]) {
      const btn = screen.getByLabelText(label);
      expect(btn.className).toContain("h-7");
      expect(btn.className).toContain("-my-1");
    }
  });
});
