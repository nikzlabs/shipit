import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

describe("FileUploadChips — recovery affordances (docs/293)", () => {
  const image = (patch: Partial<UploadItem>): UploadItem => ({
    id: "img",
    name: "shot.png",
    status: "ready",
    progress: 100,
    previewUrl: "blob:shot",
    mimeType: "image/png",
    ...patch,
  } as UploadItem);

  it("offers Retry on a failed image, not only on a failed file", () => {
    // req 2 blocks Send on a failed attachment and tells the user to "retry or
    // remove it". An image thumbnail offered neither, and drew as an ordinary
    // one, so the user could not even tell which chip was holding the message.
    const onRetry = vi.fn();
    render(
      <FileUploadChips
        uploads={[image({ status: "error", error: "Upload failed" })]}
        onRemove={vi.fn()}
        onRetry={onRetry}
      />,
    );
    const retry = screen.getByLabelText("Retry shot.png");
    expect(retry).toHaveAttribute("title", expect.stringContaining("Upload failed"));
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith(0);
  });

  it("does not offer Retry on a healthy image", () => {
    render(<FileUploadChips uploads={[image({})]} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.queryByLabelText("Retry shot.png")).toBeNull();
  });

  it("lets an in-flight upload be removed", () => {
    // req 1 bars Send while anything is uploading, so a chip with no way off the
    // screen would strand the composer.
    const onRemove = vi.fn();
    const uploading: UploadItem = { id: "1", name: "data.csv", status: "uploading", progress: 10 };
    render(<FileUploadChips uploads={[uploading]} onRemove={onRemove} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Remove data.csv"));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("lets an in-flight image upload be removed", () => {
    const onRemove = vi.fn();
    render(
      <FileUploadChips
        uploads={[image({ status: "uploading", progress: 10 })]}
        onRemove={onRemove}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Remove shot.png"));
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});

describe("FileUploadChips — the way out is actually reachable (docs/293 req 7)", () => {
  it("reveals an image's Remove without hover on touch and keyboard", () => {
    // A class assertion, deliberately: jsdom computes no styles and a synthetic
    // click cannot tell a visible control from an invisible one. What can be
    // checked is that the reveal is not hover-only — which is the defect: on a
    // touch device the control did not exist, and req 1 bars Send while an
    // attachment uploads.
    render(
      <FileUploadChips
        uploads={[{
          id: "img", name: "shot.png", status: "uploading", progress: 10,
          previewUrl: "blob:shot", mimeType: "image/png",
        } as UploadItem]}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const cls = screen.getByLabelText("Remove shot.png").className;
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("pointer-coarse:opacity-100");
    expect(cls).toContain("focus-visible:opacity-100");
  });
});
