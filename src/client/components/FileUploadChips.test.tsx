import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileUploadChips } from "./FileUploadChips.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
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

  describe("image thumbnails", () => {
    function stubStores() {
      const openPreview = vi.fn();
      const openPreviewWithContent = vi.fn();
      useFileStore.setState({ openPreview, openPreviewWithContent } as never);
      useSessionStore.setState({ sessionId: "s1" } as never);
      return { openPreview, openPreviewWithContent };
    }

    it("opens the uploaded copy when the image is ready", () => {
      const { openPreview, openPreviewWithContent } = stubStores();
      const uploads: UploadItem[] = [{
        id: "1",
        name: "shot.png",
        status: "ready",
        path: "/uploads/shot.png",
        progress: 100,
        previewUrl: "blob:shot",
        dataUrl: "data:image/png;base64,AAA",
      }];
      render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={vi.fn()} />);
      screen.getByLabelText("View shot.png full size").click();
      expect(openPreview).toHaveBeenCalledWith("s1", "/uploads/shot.png");
      expect(openPreviewWithContent).not.toHaveBeenCalled();
    });

    it("previews a pasted image from local bytes before the upload finishes", () => {
      const { openPreview, openPreviewWithContent } = stubStores();
      const uploads: UploadItem[] = [{
        id: "1",
        name: "image.png",
        status: "uploading",
        progress: 40,
        previewUrl: "blob:pasted",
      }];
      render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={vi.fn()} />);
      screen.getByLabelText("View image.png full size").click();
      expect(openPreviewWithContent).toHaveBeenCalledWith("image.png", "blob:pasted", "image");
      expect(openPreview).not.toHaveBeenCalled();
    });

    it("previews a local-only image when no session owns it", () => {
      const { openPreview, openPreviewWithContent } = stubStores();
      useSessionStore.setState({ sessionId: undefined } as never);
      const uploads: UploadItem[] = [{
        id: "1",
        name: "image.png",
        status: "ready",
        progress: 100,
        previewUrl: "blob:local",
      }];
      render(<FileUploadChips uploads={uploads} onRemove={vi.fn()} onRetry={vi.fn()} />);
      screen.getByLabelText("View image.png full size").click();
      expect(openPreviewWithContent).toHaveBeenCalledWith("image.png", "blob:local", "image");
      expect(openPreview).not.toHaveBeenCalled();
    });

    it("keeps the remove button working alongside the preview click", () => {
      stubStores();
      const onRemove = vi.fn();
      const uploads: UploadItem[] = [{
        id: "1",
        name: "shot.png",
        status: "ready",
        path: "/uploads/shot.png",
        progress: 100,
        previewUrl: "blob:shot",
      }];
      render(<FileUploadChips uploads={uploads} onRemove={onRemove} onRetry={vi.fn()} />);
      screen.getByLabelText("Remove shot.png").click();
      expect(onRemove).toHaveBeenCalledWith(0);
    });
  });
});
