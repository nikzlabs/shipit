import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";

afterEach(cleanup);

describe("MessageInput", () => {
  describe("basic functionality", () => {
    it("renders the input textarea and send button", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.getByPlaceholderText("Tell Claude what to build...")).toBeInTheDocument();
      expect(screen.getByText("Send")).toBeInTheDocument();
    });

    it("renders the attach image button", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.getByLabelText("Attach image")).toBeInTheDocument();
    });

    it("sends text message on submit", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Tell Claude what to build...");
      fireEvent.change(textarea, { target: { value: "Hello Claude" } });
      fireEvent.click(screen.getByText("Send"));
      expect(onSend).toHaveBeenCalledWith("Hello Claude", undefined);
    });

    it("sends text on Enter (without Shift)", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Tell Claude what to build...");
      fireEvent.change(textarea, { target: { value: "test" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSend).toHaveBeenCalledWith("test", undefined);
    });

    it("does not send empty messages", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      fireEvent.click(screen.getByText("Send"));
      expect(onSend).not.toHaveBeenCalled();
    });

    it("disables input when disabled prop is true", () => {
      render(<MessageInput onSend={vi.fn()} disabled={true} />);
      const textarea = screen.getByPlaceholderText("Tell Claude what to build...");
      expect(textarea).toBeDisabled();
    });
  });

  describe("drag and drop", () => {
    it("shows drop zone overlay when dragging over", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const container = screen.getByPlaceholderText("Tell Claude what to build...").closest("div.border-t")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop image here")).toBeInTheDocument();
    });

    it("hides drop zone overlay when dragging out", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const container = screen.getByPlaceholderText("Tell Claude what to build...").closest("div.border-t")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop image here")).toBeInTheDocument();
      fireEvent.dragLeave(container, { dataTransfer: { files: [] } });
      expect(screen.queryByText("Drop image here")).not.toBeInTheDocument();
    });
  });

  describe("file picker", () => {
    it("has a hidden file input with correct accept attribute", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
      expect(fileInput.type).toBe("file");
      expect(fileInput.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
      expect(fileInput.multiple).toBe(true);
    });
  });

  describe("image error handling", () => {
    it("shows error for unsupported file types", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const textFile = new File(["hello"], "doc.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      await waitFor(() => {
        expect(screen.getByText(/not a supported image type/)).toBeInTheDocument();
      });
    });

    it("shows error for oversized files", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      // Create a file that reports as > 5MB
      const bigFile = new File(["x".repeat(100)], "big.png", { type: "image/png" });
      Object.defineProperty(bigFile, "size", { value: 6 * 1024 * 1024 });
      fireEvent.change(fileInput, { target: { files: [bigFile] } });

      await waitFor(() => {
        expect(screen.getByText(/too large/)).toBeInTheDocument();
      });
    });

    it("dismisses error when close button is clicked", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const textFile = new File(["hello"], "doc.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      await waitFor(() => {
        expect(screen.getByText(/not a supported image type/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("\u00d7")); // × button
      expect(screen.queryByText(/not a supported image type/)).not.toBeInTheDocument();
    });
  });

  describe("image thumbnails", () => {
    let originalFileReader: typeof FileReader;

    beforeEach(() => {
      originalFileReader = globalThis.FileReader;

      // Create a mock FileReader class
      class MockFileReader {
        result: string = "data:image/png;base64,dGVzdA==";
        onload: (() => void) | null = null;
        readAsDataURL() {
          // Simulate async completion
          setTimeout(() => this.onload?.(), 0);
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
      globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/test");
      globalThis.URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
      globalThis.FileReader = originalFileReader;
    });

    it("shows image thumbnails after adding valid files", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const pngFile = new File(["test"], "screenshot.png", { type: "image/png" });
      Object.defineProperty(pngFile, "size", { value: 1024 });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByTestId("image-thumbnails")).toBeInTheDocument();
      });
    });

    it("shows remove button on image thumbnails", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const pngFile = new File(["test"], "photo.png", { type: "image/png" });
      Object.defineProperty(pngFile, "size", { value: 1024 });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
      });
    });

    it("removes image when remove button is clicked", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const pngFile = new File(["test"], "photo.png", { type: "image/png" });
      Object.defineProperty(pngFile, "size", { value: 1024 });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText("Remove photo.png"));

      await waitFor(() => {
        expect(screen.queryByTestId("image-thumbnails")).not.toBeInTheDocument();
      });
    });

    it("sends images along with text when submitting", async () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const pngFile = new File(["test"], "photo.png", { type: "image/png" });
      Object.defineProperty(pngFile, "size", { value: 1024 });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByTestId("image-thumbnails")).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText("Tell Claude what to build...");
      fireEvent.change(textarea, { target: { value: "Check this" } });
      fireEvent.click(screen.getByText("Send"));

      expect(onSend).toHaveBeenCalledWith(
        "Check this",
        expect.arrayContaining([
          expect.objectContaining({ mediaType: "image/png", filename: "photo.png" }),
        ]),
      );
    });

    it("clears images after sending", async () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const fileInput = screen.getByTestId("file-input");

      const pngFile = new File(["test"], "photo.png", { type: "image/png" });
      Object.defineProperty(pngFile, "size", { value: 1024 });
      fireEvent.change(fileInput, { target: { files: [pngFile] } });

      await waitFor(() => {
        expect(screen.getByTestId("image-thumbnails")).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText("Tell Claude what to build...");
      fireEvent.change(textarea, { target: { value: "Send it" } });
      fireEvent.click(screen.getByText("Send"));

      // After sending, thumbnails should be gone
      await waitFor(() => {
        expect(screen.queryByTestId("image-thumbnails")).not.toBeInTheDocument();
      });
    });
  });

  describe("activity indicator", () => {
    it("shows activity label when provided", () => {
      render(<MessageInput onSend={vi.fn()} disabled={true} activity={{ label: "Thinking..." }} />);
      expect(screen.getByText("Thinking...")).toBeInTheDocument();
    });

    it("hides activity label when not provided", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    });
  });
});
