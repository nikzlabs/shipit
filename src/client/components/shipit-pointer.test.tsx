/**
 * Rendering half of docs/258 — how an agent-authored pointer appears in chat,
 * and (the security-critical part) where the schemes are live at all.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownContent } from "./message-markdown.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePresentStore } from "../stores/present-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";

beforeEach(() => {
  useSessionStore.setState({ sessionId: "sess-1" });
  usePreviewStore.setState({ services: [], previewLinkIntent: null, selectedPort: null });
  usePresentStore.getState().reset();
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("agent-authored pointers — rendering", () => {
  it("renders a preview pointer as a prose link by default", () => {
    render(<MarkdownContent text="Look at [the run](shipit-preview://web/runs/1)." shipitLinks />);
    const el = screen.getByRole("button", { name: "the run" });
    // No real href: a custom-protocol href would be handed to the OS protocol
    // handler on middle-click / "open in new tab".
    expect(el.getAttribute("href")).toBeNull();
    expect(el.tagName).toBe("A");
  });

  it("renders the badge and button forms the agent asked for", () => {
    render(
      <MarkdownContent
        text={
          "[REQ-7](shipit-present:/persist/r.html?shipit-render=badge#req-7)\n\n"
          + "[Open it](shipit-present:/persist/r.html?shipit-render=button#req-7)"
        }
        shipitLinks
      />,
    );
    expect(screen.getByRole("button", { name: "REQ-7" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open it" })).toBeTruthy();
  });

  it("keeps a pointer clickable when it cannot be opened, and says why (req 10)", async () => {
    const user = userEvent.setup();
    render(<MarkdownContent text="[bad](shipit-preview://web:3000/x)" shipitLinks />);
    await user.click(screen.getByRole("button", { name: "bad" }));
    expect(useUiStore.getState().toast?.variant).toBe("error");
    expect(useUiStore.getState().toast?.message).toContain("not a valid service name");
  });

  it("is keyboard-operable, since it carries no href", async () => {
    usePreviewStore.setState({
      services: [{ name: "web", status: "running", port: 5173, preview: "auto" }],
    });
    const user = userEvent.setup();
    render(<MarkdownContent text="[go](shipit-preview://web/x)" shipitLinks />);
    screen.getByRole("button", { name: "go" }).focus();
    await user.keyboard("{Enter}");
    expect(usePreviewStore.getState().previewLinkIntent?.targetPath).toBe("/x");
  });
});

describe("agent-authored pointers — where the schemes are live", () => {
  // The security boundary. `MarkdownContent` is shared with PR descriptions and
  // comments, issue bodies, reviews and subagent reports — all text ShipIt did
  // NOT author. A pointer there could present a button that starts a Compose
  // service (req 12), which is exactly the untrusted-input boundary.
  it("is inert without the opt-in, rendering only the label", async () => {
    usePreviewStore.setState({
      services: [{ name: "web", status: "stopped", port: 5173, preview: "auto" }],
    });
    const user = userEvent.setup();
    render(<MarkdownContent text="[start it](shipit-preview://web/x)" />);

    expect(screen.queryByRole("button", { name: "start it" })).toBeNull();
    expect(screen.queryByRole("link", { name: "start it" })).toBeNull();
    expect(screen.getByText("start it")).toBeTruthy();

    await user.click(screen.getByText("start it"));
    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("does not leak the scheme into an href on a non-opted-in surface", () => {
    const { container } = render(
      <MarkdownContent text="[x](shipit-present:/persist/r.html)" />,
    );
    expect(container.innerHTML).not.toContain("shipit-present");
  });
});

describe("agent-authored pointers — branch order", () => {
  it("wins over the repo-file branch, which would read it as a path", async () => {
    // `shipit-present:/persist/x.html` has no `://`, so `parseRepoFileLink`
    // accepts it as a repo path and would open the file preview modal.
    const openPreview = vi.fn();
    useFileStore.setState({ openPreview } as never);
    const user = userEvent.setup();
    render(<MarkdownContent text="[art](shipit-present:/persist/x.html)" shipitLinks />);

    await user.click(screen.getByRole("button", { name: "art" }));
    expect(openPreview).not.toHaveBeenCalled();
    // Nothing presented from that path — req 10 reports the path.
    expect(useUiStore.getState().toast?.message).toContain("/persist/x.html");
  });

  it("leaves ordinary repo-file and external links alone", () => {
    render(
      <MarkdownContent
        text={"[file](src/foo.ts:12)\n\n[out](https://example.com/x)"}
        shipitLinks
      />,
    );
    expect(screen.getByRole("button", { name: "file" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "out" }).getAttribute("href"))
      .toBe("https://example.com/x");
  });
});
