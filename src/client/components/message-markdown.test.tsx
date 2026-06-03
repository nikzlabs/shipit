import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownContent } from "./message-markdown.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownContent links", () => {
  it("opens the file preview when a repo-path link is clicked", async () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    const openPreview = vi.fn().mockResolvedValue(undefined);
    useFileStore.setState({ openPreview });

    render(<MarkdownContent text="See [the file](src/server/foo.ts:42) here." />);
    await userEvent.click(screen.getByText("the file"));

    expect(openPreview).toHaveBeenCalledWith("sess-1", "src/server/foo.ts", { line: 42 });
  });

  it("opens at the top (no line) for a repo path without a line suffix", async () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    const openPreview = vi.fn().mockResolvedValue(undefined);
    useFileStore.setState({ openPreview });

    render(<MarkdownContent text="[plan](docs/001-foo/plan.md)" />);
    await userEvent.click(screen.getByText("plan"));

    expect(openPreview).toHaveBeenCalledWith("sess-1", "docs/001-foo/plan.md", { line: undefined });
  });

  it("does not intercept external links", async () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    const openPreview = vi.fn().mockResolvedValue(undefined);
    useFileStore.setState({ openPreview });

    render(<MarkdownContent text="[docs](https://example.com/docs)" />);
    const link = screen.getByText("docs").closest("a")!;

    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    await userEvent.click(link);
    expect(openPreview).not.toHaveBeenCalled();
  });
});
