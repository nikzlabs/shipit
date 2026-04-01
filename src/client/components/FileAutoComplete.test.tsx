import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileAutoComplete } from "./FileAutoComplete.js";
import { Popover, PopoverAnchor } from "./ui/popover.js";
import type { FileTreeNode } from "../../server/shared/types.js";

afterEach(cleanup);

/** Wrap FileAutoComplete in a Popover context (required since it renders PopoverContent). */
function PopoverWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Popover open modal={false}>
      <PopoverAnchor asChild><div style={{ width: 400 }} /></PopoverAnchor>
      {children}
    </Popover>
  );
}

const sampleTree: FileTreeNode[] = [
  {
    name: "src",
    path: "src",
    type: "directory",
    children: [
      { name: "index.ts", path: "src/index.ts", type: "file" },
      { name: "utils.ts", path: "src/utils.ts", type: "file" },
      {
        name: "components",
        path: "src/components",
        type: "directory",
        children: [
          { name: "App.tsx", path: "src/components/App.tsx", type: "file" },
        ],
      },
    ],
  },
  { name: "package.json", path: "package.json", type: "file" },
];

describe("FileAutoComplete", () => {
  it("shows matching files when query is provided", () => {
    render(
      <PopoverWrapper><FileAutoComplete
        query="utils"
        fileTree={sampleTree}
        onSelect={() => {}}
        onDismiss={() => {}}
      /></PopoverWrapper>,
    );
    const items = screen.getAllByTestId("file-autocomplete-item");
    expect(items.length).toBe(1);
    expect(items[0]).toHaveTextContent("src/utils.ts");
  });

  it("shows all files (up to 20) when query is empty", () => {
    render(
      <PopoverWrapper><FileAutoComplete
        query=""
        fileTree={sampleTree}
        onSelect={() => {}}
        onDismiss={() => {}}
      /></PopoverWrapper>,
    );
    const items = screen.getAllByTestId("file-autocomplete-item");
    expect(items.length).toBe(4); // index.ts, utils.ts, App.tsx, package.json
  });

  it("calls onSelect when a file is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PopoverWrapper><FileAutoComplete
        query="package"
        fileTree={sampleTree}
        onSelect={onSelect}
        onDismiss={() => {}}
      /></PopoverWrapper>,
    );
    const item = screen.getByTestId("file-autocomplete-item");
    await user.click(item);
    expect(onSelect).toHaveBeenCalledWith("package.json");
  });

  it("calls onSelect on Enter key", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PopoverWrapper><FileAutoComplete
        query="index"
        fileTree={sampleTree}
        onSelect={onSelect}
        onDismiss={() => {}}
      /></PopoverWrapper>,
    );
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("src/index.ts");
  });

  it("calls onDismiss on Escape key", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <PopoverWrapper><FileAutoComplete
        query="index"
        fileTree={sampleTree}
        onSelect={() => {}}
        onDismiss={onDismiss}
      /></PopoverWrapper>,
    );
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("shows 'No matching files' when nothing matches", () => {
    render(
      <PopoverWrapper><FileAutoComplete
        query="nonexistent-file-xyz"
        fileTree={sampleTree}
        onSelect={() => {}}
        onDismiss={() => {}}
      /></PopoverWrapper>,
    );
    expect(screen.getByText("No matching files")).toBeTruthy();
  });

  it("filters are case-insensitive", () => {
    render(
      <PopoverWrapper><FileAutoComplete
        query="APP"
        fileTree={sampleTree}
        onSelect={() => {}}
        onDismiss={() => {}}
      /></PopoverWrapper>,
    );
    const items = screen.getAllByTestId("file-autocomplete-item");
    expect(items.length).toBe(1);
    expect(items[0]).toHaveTextContent("src/components/App.tsx");
  });
});
