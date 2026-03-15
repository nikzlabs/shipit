import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileUploadChips } from "./FileUploadChips.js";
import type { UploadItem } from "../hooks/useFileUpload.js";

afterEach(cleanup);

describe("FileUploadChips", () => {
  it("renders nothing when empty", () => {
    const { container } = render(
      <FileUploadChips uploads={[]} onRemove={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders uploading state with spinner", () => {
    const uploads: UploadItem[] = [{
      id: "1",
      name: "data.csv",
      status: "uploading",
      progress: 50,
    }];
    render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByTestId("upload-chip-name")).toHaveTextContent("data.csv");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("renders ready state with size and remove button", () => {
    const uploads: UploadItem[] = [{
      id: "1",
      name: "data.csv",
      status: "ready",
      size: 4096,
      path: "/uploads/data.csv",
      progress: 100,
    }];
    render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByTestId("upload-chip-name")).toHaveTextContent("data.csv");
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove data.csv")).toBeInTheDocument();
  });

  it("renders error state with retry button", () => {
    const uploads: UploadItem[] = [{
      id: "1",
      name: "fail.txt",
      status: "error",
      error: "Upload failed",
      progress: 0,
    }];
    render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByTestId("upload-chip-name")).toHaveTextContent("fail.txt");
    expect(screen.getByLabelText("Retry fail.txt")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove fail.txt")).toBeInTheDocument();
  });

  it("calls onRemove when remove button clicked", () => {
    const onRemove = vi.fn();
    const uploads: UploadItem[] = [{
      id: "1",
      name: "data.csv",
      status: "ready",
      size: 100,
      path: "/uploads/data.csv",
      progress: 100,
    }];
    render(<FileUploadChips uploads={uploads} onRemove={onRemove} onRetry={vi.fn()} />);
    screen.getByLabelText("Remove data.csv").click();
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("calls onRetry when retry button clicked", () => {
    const onRetry = vi.fn();
    const uploads: UploadItem[] = [{
      id: "1",
      name: "fail.txt",
      status: "error",
      error: "Fail",
      progress: 0,
    }];
    render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={onRetry} />);
    screen.getByLabelText("Retry fail.txt").click();
    expect(onRetry).toHaveBeenCalledWith(0);
  });
});
