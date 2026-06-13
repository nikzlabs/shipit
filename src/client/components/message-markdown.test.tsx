import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownContent } from "./message-markdown.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { TrackerInfo } from "../../server/shared/types.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LINEAR_CONNECTED: TrackerInfo = { id: "linear", label: "Linear", configured: true };
const LINEAR_DISCONNECTED: TrackerInfo = { id: "linear", label: "Linear", configured: false };

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

describe("MarkdownContent tracker-issue links", () => {
  it("opens the in-app viewer when an issue URL's tracker is connected", async () => {
    const openIssue = vi.fn().mockResolvedValue(undefined);
    const setRightTab = vi.fn();
    const setMobilePanel = vi.fn();
    useIssuesStore.setState({ trackers: [LINEAR_CONNECTED], openIssue });
    useUiStore.setState({ setRightTab, setMobilePanel });

    render(
      <MarkdownContent text="See [SHI-137](https://linear.app/shipit-ai/issue/SHI-137) for details." />,
    );
    const link = screen.getByText("SHI-137").closest("a")!;
    // The anchor still carries the external href + target as the escape hatch.
    expect(link).toHaveAttribute("href", "https://linear.app/shipit-ai/issue/SHI-137");
    expect(link).toHaveAttribute("target", "_blank");

    await userEvent.click(link);

    expect(openIssue).toHaveBeenCalledWith({
      tracker: "linear",
      id: "SHI-137",
      identifier: "SHI-137",
      url: "https://linear.app/shipit-ai/issue/SHI-137",
    });
    expect(setRightTab).toHaveBeenCalledWith("issues");
    expect(setMobilePanel).toHaveBeenCalledWith("preview");
  });

  it("links out (no in-app open) when the tracker is NOT connected", async () => {
    const openIssue = vi.fn().mockResolvedValue(undefined);
    const setRightTab = vi.fn();
    useIssuesStore.setState({ trackers: [LINEAR_DISCONNECTED], openIssue });
    useUiStore.setState({ setRightTab });

    render(<MarkdownContent text="[SHI-137](https://linear.app/shipit-ai/issue/SHI-137)" />);
    const link = screen.getByText("SHI-137").closest("a")!;
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://linear.app/shipit-ai/issue/SHI-137");

    await userEvent.click(link);

    expect(openIssue).not.toHaveBeenCalled();
    expect(setRightTab).not.toHaveBeenCalled();
  });

  it("never intercepts a GitHub PR URL, even with the tracker connected", async () => {
    const openIssue = vi.fn().mockResolvedValue(undefined);
    useIssuesStore.setState({
      trackers: [{ id: "github", label: "GitHub", configured: true }],
      openIssue,
    });

    render(<MarkdownContent text="[PR](https://github.com/owner/repo/pull/42)" />);
    const link = screen.getByText("PR").closest("a")!;
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");

    await userEvent.click(link);
    expect(openIssue).not.toHaveBeenCalled();
  });
});
