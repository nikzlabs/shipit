import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DiffPanel, type TurnDiffData } from "./DiffPanel.js";
import type { FileDiff } from "../../server/shared/types.js";

// Mock Monaco DiffEditor — it doesn't work in jsdom
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: { original: string; modified: string; language: string }) => (
    <div data-testid="mock-diff-editor" data-language={props.language}>
      <pre data-testid="original">{props.original}</pre>
      <pre data-testid="modified">{props.modified}</pre>
    </div>
  ),
}));

function makeFile(overrides?: Partial<FileDiff>): FileDiff {
  return {
    path: "src/app.ts",
    status: "modified",
    insertions: 5,
    deletions: 2,
    binary: false,
    oldContent: "const x = 1;",
    newContent: "const x = 2;",
    ...overrides,
  };
}

function makeDiff(overrides?: Partial<TurnDiffData>): TurnDiffData {
  return {
    fromCommit: "aaa1111",
    toCommit: "bbb2222",
    files: [makeFile()],
    stats: { totalInsertions: 5, totalDeletions: 2, filesChanged: 1 },
    ...overrides,
  };
}

describe("DiffPanel", () => {
  const defaultProps = () => ({
    diff: makeDiff(),
    onClose: vi.fn(),
  });

  afterEach(cleanup);

  describe("rendering", () => {
    it("shows stats in the header", () => {
      render(<DiffPanel {...defaultProps()} />);
      // Stats appear in both header and file sidebar, so use getAllByText
      expect(screen.getAllByText("+5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("-2").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("(1 file)")).toBeInTheDocument();
    });

    it("shows plural 'files' for multiple files", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [makeFile({ path: "a.ts" }), makeFile({ path: "b.ts" })],
        stats: { totalInsertions: 10, totalDeletions: 4, filesChanged: 2 },
      });
      render(<DiffPanel {...props} />);
      expect(screen.getByText("(2 files)")).toBeInTheDocument();
    });

    it("shows file names in sidebar", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [
          makeFile({ path: "src/foo.ts" }),
          makeFile({ path: "src/bar.ts" }),
        ],
        stats: { totalInsertions: 10, totalDeletions: 4, filesChanged: 2 },
      });
      render(<DiffPanel {...props} />);
      expect(screen.getByText("foo.ts")).toBeInTheDocument();
      expect(screen.getByText("bar.ts")).toBeInTheDocument();
    });

    it("shows status icons for different file statuses", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [
          makeFile({ path: "added.ts", status: "added" }),
          makeFile({ path: "modified.ts", status: "modified" }),
          makeFile({ path: "deleted.ts", status: "deleted" }),
        ],
        stats: { totalInsertions: 10, totalDeletions: 4, filesChanged: 3 },
      });
      render(<DiffPanel {...props} />);
      expect(screen.getByText("A")).toBeInTheDocument();
      expect(screen.getByText("M")).toBeInTheDocument();
      expect(screen.getByText("D")).toBeInTheDocument();
    });

    it("shows commit hash range in footer", () => {
      render(<DiffPanel {...defaultProps()} />);
      expect(screen.getByText("aaa1111..bbb2222")).toBeInTheDocument();
    });

    it("renders Monaco DiffEditor for selected file", () => {
      render(<DiffPanel {...defaultProps()} />);
      expect(screen.getByTestId("mock-diff-editor")).toBeInTheDocument();
      expect(screen.getByTestId("original")).toHaveTextContent("const x = 1;");
      expect(screen.getByTestId("modified")).toHaveTextContent("const x = 2;");
    });

    it("shows binary file message for binary files", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [makeFile({ path: "image.png", binary: true })],
      });
      render(<DiffPanel {...props} />);
      expect(screen.getByText(/Binary file/)).toBeInTheDocument();
    });
  });

  describe("file selection", () => {
    it("shows diff for clicked file", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [
          makeFile({ path: "src/first.ts", oldContent: "old1", newContent: "new1" }),
          makeFile({ path: "src/second.ts", oldContent: "old2", newContent: "new2" }),
        ],
        stats: { totalInsertions: 10, totalDeletions: 4, filesChanged: 2 },
      });
      render(<DiffPanel {...props} />);

      // Initially shows first file
      expect(screen.getByTestId("original")).toHaveTextContent("old1");

      // Click second file
      fireEvent.click(screen.getByText("second.ts"));
      expect(screen.getByTestId("original")).toHaveTextContent("old2");
      expect(screen.getByTestId("modified")).toHaveTextContent("new2");
    });
  });

  describe("actions", () => {
    it("calls onClose when close button is clicked", () => {
      const props = defaultProps();
      render(<DiffPanel {...props} />);
      fireEvent.click(screen.getByLabelText("Close diff panel"));
      expect(props.onClose).toHaveBeenCalledOnce();
    });

    it("calls onClose when Close button in footer is clicked", () => {
      const props = defaultProps();
      render(<DiffPanel {...props} />);
      fireEvent.click(screen.getByText("Close"));
      expect(props.onClose).toHaveBeenCalledOnce();
    });

    it("does not render any checkboxes", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [makeFile({ path: "src/foo.ts" }), makeFile({ path: "src/bar.ts" })],
        stats: { totalInsertions: 10, totalDeletions: 4, filesChanged: 2 },
      });
      render(<DiffPanel {...props} />);
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });
  });

  describe("empty diff", () => {
    it("shows no changes message when files array is empty", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [],
        stats: { totalInsertions: 0, totalDeletions: 0, filesChanged: 0 },
      });
      render(<DiffPanel {...props} />);
      expect(screen.getByText("No file changes in this turn.")).toBeInTheDocument();
    });
  });

  describe("language detection", () => {
    it("passes correct language for TypeScript files", () => {
      const props = defaultProps();
      props.diff = makeDiff({ files: [makeFile({ path: "src/app.tsx" })] });
      render(<DiffPanel {...props} />);
      expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-language", "typescript");
    });

    it("passes correct language for Python files", () => {
      const props = defaultProps();
      props.diff = makeDiff({ files: [makeFile({ path: "main.py" })] });
      render(<DiffPanel {...props} />);
      expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-language", "python");
    });

    it("defaults to plaintext for unknown extensions", () => {
      const props = defaultProps();
      props.diff = makeDiff({ files: [makeFile({ path: "README" })] });
      render(<DiffPanel {...props} />);
      expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-language", "plaintext");
    });
  });

  describe("rename display", () => {
    it("shows old path → new path for renamed files", () => {
      const props = defaultProps();
      props.diff = makeDiff({
        files: [makeFile({ path: "new-name.ts", oldPath: "old-name.ts", status: "renamed" })],
      });
      render(<DiffPanel {...props} />);
      expect(screen.getByText("old-name.ts → new-name.ts")).toBeInTheDocument();
    });
  });

  describe("commit message display", () => {
    it("shows commit message in header when provided", () => {
      const props = defaultProps();
      render(<DiffPanel {...props} commitMessage="feat: add new feature" />);
      expect(screen.getByText("feat: add new feature")).toBeInTheDocument();
    });

    it("shows 'Changes' in header when no commit message provided", () => {
      const props = defaultProps();
      render(<DiffPanel {...props} />);
      expect(screen.getByText("Changes")).toBeInTheDocument();
    });
  });
});
