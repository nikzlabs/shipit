import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileAttachmentChips, type FileChipItem } from "./FileAttachmentChips.js";

afterEach(cleanup);

describe("FileAttachmentChips", () => {
  it("renders nothing when files array is empty", () => {
    const { container } = render(<FileAttachmentChips files={[]} onRemove={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a chip for each attached file", () => {
    const files: FileChipItem[] = [
      { path: "src/utils/format.ts" },
      { path: "package.json" },
    ];
    render(<FileAttachmentChips files={files} onRemove={() => {}} />);
    const chips = screen.getAllByTestId("file-chip-name");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("src/utils/format.ts");
    expect(chips[1]).toHaveTextContent("package.json");
  });

  it("calls onRemove with the correct index when remove button is clicked", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const files: FileChipItem[] = [
      { path: "a.ts" },
      { path: "b.ts" },
    ];
    render(<FileAttachmentChips files={files} onRemove={onRemove} />);
    const removeButtons = screen.getAllByRole("button", { name: /Remove/ });
    await user.click(removeButtons[1]);
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it("shows line range badge when startLine and endLine are set", () => {
    const files: FileChipItem[] = [
      { path: "src/index.ts", startLine: 12, endLine: 45 },
    ];
    render(<FileAttachmentChips files={files} onRemove={() => {}} />);
    expect(screen.getByTestId("file-chip-range")).toHaveTextContent("L12-45");
  });

  it("does not show line range badge when startLine/endLine are absent", () => {
    const files: FileChipItem[] = [
      { path: "src/index.ts" },
    ];
    render(<FileAttachmentChips files={files} onRemove={() => {}} />);
    expect(screen.queryByTestId("file-chip-range")).toBeNull();
  });

  it("truncates long paths with ellipsis", () => {
    const longPath = "src/some/very/deeply/nested/directory/structure/file.ts";
    const files: FileChipItem[] = [
      { path: longPath },
    ];
    render(<FileAttachmentChips files={files} onRemove={() => {}} />);
    const chip = screen.getByTestId("file-chip-name");
    expect(chip.textContent.startsWith("...")).toBe(true);
  });

  it("renders the file icon SVG", () => {
    const files: FileChipItem[] = [
      { path: "test.ts" },
    ];
    const { container } = render(<FileAttachmentChips files={files} onRemove={() => {}} />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
