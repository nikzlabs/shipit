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

// docs/248 — Linear is a declared tracker bound to a team, so the destination id
// carries the team key and the declaration carries the name every reference
// resolves through.
const LINEAR_CONNECTED: TrackerInfo = {
  id: "linear:SHI",
  kind: "linear",
  label: "roadmap",
  name: "roadmap",
  configured: true,
  binding: { key: "SHI", name: "SHI" },
};
const LINEAR_DISCONNECTED: TrackerInfo = { ...LINEAR_CONNECTED, configured: false };

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

  it("gives a repo-path link no navigable href", async () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    useFileStore.setState({ openPreview: vi.fn().mockResolvedValue(undefined) });

    render(<MarkdownContent text="See [the file](src/server/foo.ts:42) here." />);
    const link = screen.getByText("the file").closest("a")!;

    // A relative href would resolve against the session route — the browser
    // would show `/session/src/server/foo.ts` on hover and 404 on
    // middle-click / ⌘-click / "Open link in new tab".
    expect(link).not.toHaveAttribute("href");
    expect(link).not.toHaveAttribute("target");
    // Still reachable by keyboard, and the tooltip names the file.
    expect(link).toHaveAttribute("role", "button");
    expect(link).toHaveAttribute("tabindex", "0");
    expect(link).toHaveAttribute("title", "Open src/server/foo.ts:42");
  });

  it("opens the file preview when a bare path in prose is activated by keyboard", async () => {
    useSessionStore.setState({ sessionId: "sess-1" });
    const openPreview = vi.fn().mockResolvedValue(undefined);
    useFileStore.setState({ openPreview });

    render(<MarkdownContent text="One edit to verdicts/flagging_policy.ts" />);
    const link = screen.getByText("verdicts/flagging_policy.ts").closest("a")!;
    expect(link).not.toHaveAttribute("href");

    link.focus();
    await userEvent.keyboard("{Enter}");

    expect(openPreview).toHaveBeenCalledWith("sess-1", "verdicts/flagging_policy.ts", {
      line: undefined,
    });
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
      tracker: "linear:SHI",
      id: "SHI-137",
      // req 15 — the destination's name form.
      identifier: "roadmap#SHI-137",
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

  // docs/248 req 11 — a bare key is a NAME-less reference, so it identifies a
  // destination only if exactly one declaration binds that team. Two make it
  // ambiguous, and picking the first would route the click at a destination the
  // key does not identify. Ambiguous falls back to plain text, like undeclared.
  it("renders a bare key as plain text when two declarations bind the same team", async () => {
    const openIssue = vi.fn().mockResolvedValue(undefined);
    useIssuesStore.setState({
      trackers: [LINEAR_CONNECTED, { ...LINEAR_CONNECTED, id: "linear:SHI", name: "backlog", label: "backlog" }],
      openIssue,
    });

    render(<MarkdownContent text="Fixed in SHI-137 today." />);

    expect(screen.queryByRole("button", { name: "SHI-137" })).toBeNull();
    expect(screen.getByText(/Fixed in/).textContent).toContain("SHI-137");
  });

  it("still badges a bare key when exactly one declaration binds the team", async () => {
    const openIssue = vi.fn().mockResolvedValue(undefined);
    useIssuesStore.setState({ trackers: [LINEAR_CONNECTED], openIssue });
    useUiStore.setState({ setRightTab: vi.fn(), setMobilePanel: vi.fn() });

    render(<MarkdownContent text="Fixed in SHI-137 today." />);
    await userEvent.click(screen.getByRole("button", { name: "SHI-137" }));

    expect(openIssue).toHaveBeenCalledWith(
      expect.objectContaining({ tracker: "linear:SHI", id: "SHI-137", identifier: "roadmap#SHI-137" }),
    );
  });

  it("never intercepts a GitHub PR URL, even with the tracker connected", async () => {
    const openIssue = vi.fn().mockResolvedValue(undefined);
    useIssuesStore.setState({
      trackers: [{ id: "github", kind: "github" as const, label: "GitHub", configured: true }],
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
