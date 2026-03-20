import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";

afterEach(cleanup);

describe("MessageInput", () => {
  describe("basic functionality", () => {
    it("renders the input textarea and send button", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.getByPlaceholderText("Describe what to build... (type @ to attach files)")).toBeInTheDocument();
      expect(screen.getByLabelText("Send message")).toBeInTheDocument();
    });

    it("renders the add files button", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.getByLabelText("Add files")).toBeInTheDocument();
    });

    it("sends text message on submit", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "Hello Claude" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).toHaveBeenCalledWith("Hello Claude");
    });

    it("sends text on Enter (without Shift)", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "test" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSend).toHaveBeenCalledWith("test");
    });

    it("does not send empty messages", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).not.toHaveBeenCalled();
    });

    it("disables input when disabled prop is true", () => {
      render(<MessageInput onSend={vi.fn()} disabled={true} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      expect(textarea).toBeDisabled();
    });
  });

  describe("plan mode toggle", () => {
    it("renders plan mode toggle when onPermissionModeChange is provided", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} onPermissionModeChange={vi.fn()} />);
      expect(screen.getByTestId("plan-mode-toggle")).toBeInTheDocument();
    });

    it("does not render plan mode toggle when onPermissionModeChange is not provided", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.queryByTestId("plan-mode-toggle")).not.toBeInTheDocument();
    });
  });

  describe("model agent selector", () => {
    it("renders model selector when onAgentChange is provided", () => {
      render(
        <MessageInput
          onSend={vi.fn()}
          disabled={false}
          onAgentChange={vi.fn()}
          agents={[{ id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet-4"] }]}
          modelInfo={{ model: "Opus 4.6", contextWindowTokens: 200000 }}
        />,
      );
      expect(screen.getByTestId("model-agent-selector")).toBeInTheDocument();
      expect(screen.getByText("Opus 4.6")).toBeInTheDocument();
    });
  });

  describe("drag and drop", () => {
    it("shows drop zone overlay when dragging over", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const container = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)").closest("div.border-t")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop files here")).toBeInTheDocument();
    });

    it("hides drop zone overlay when dragging out", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const container = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)").closest("div.border-t")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop files here")).toBeInTheDocument();
      fireEvent.dragLeave(container, { dataTransfer: { files: [] } });
      expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
    });
  });

  describe("file picker", () => {
    it("has a hidden file input that accepts all file types", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
      expect(fileInput.type).toBe("file");
      expect(fileInput.accept).toBe(""); // accepts all file types
      expect(fileInput.multiple).toBe(true);
    });

    it("routes all files (including images) to onUploadFiles callback", () => {
      const onUploadFiles = vi.fn();
      render(<MessageInput onSend={vi.fn()} disabled={false} onUploadFiles={onUploadFiles} />);
      const fileInput = screen.getByTestId("file-input");

      const textFile = new File(["hello"], "doc.txt", { type: "text/plain" });
      const pngFile = new File(["img"], "photo.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [textFile, pngFile] } });

      expect(onUploadFiles).toHaveBeenCalledWith([textFile, pngFile]);
    });
  });

});
