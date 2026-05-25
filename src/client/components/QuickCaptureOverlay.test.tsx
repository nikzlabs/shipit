import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { QuickCaptureOverlay } from "./QuickCaptureOverlay.js";
import type { MessageInput } from "./MessageInput.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionInfo } from "../../server/shared/types.js";
import type { RepoInfo } from "../../server/shared/types.js";

const createHeadlessSessionMock = vi.hoisted(() => vi.fn());
type MessageInputProps = ComponentProps<typeof MessageInput>;
let lastMessageInputProps: MessageInputProps | undefined;

vi.mock("../stores/actions/session-actions.js", () => ({
  createHeadlessSession: createHeadlessSessionMock,
}));

vi.mock("./MessageInput.js", () => ({
  MessageInput: (props: MessageInputProps) => {
    lastMessageInputProps = props;
    return (
      <div data-testid="message-input" data-surface={props.surface} data-disabled={String(props.disabled)}>
        <button onClick={() => props.onSend("captured prompt")}>Send mock</button>
      </div>
    );
  },
}));

function session(id: string, remoteUrl: string): SessionInfo {
  return {
    id,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl,
  };
}

function repo(url: string, status: RepoInfo["status"] = "ready"): RepoInfo {
  return {
    url,
    status,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  };
}

function openOverlay() {
  useUiStore.setState({ quickCaptureOpen: true, bootstrapLoaded: true });
}

describe("QuickCaptureOverlay", () => {
  beforeEach(() => {
    createHeadlessSessionMock.mockReset();
    lastMessageInputProps = undefined;
    useUiStore.setState({
      quickCaptureOpen: false,
      bootstrapLoaded: false,
      agentList: [{
        id: "claude",
        name: "Claude",
        installed: true,
        authConfigured: true,
        models: [],
        supportsReview: true,
      }],
      modelInfo: null,
    });
    useRepoStore.setState({
      repos: [],
      activeRepoUrl: undefined,
    });
    useSessionStore.setState({
      sessionId: undefined,
      sessions: [],
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUiStore.setState({ quickCaptureOpen: false, bootstrapLoaded: false });
    useRepoStore.setState({ repos: [], activeRepoUrl: undefined });
    useSessionStore.setState({ sessionId: undefined, sessions: [] });
  });

  it("renders MessageInput with the overlay surface and defaults to the active session repo", () => {
    const activeUrl = "https://github.com/acme/active.git";
    useRepoStore.setState({
      repos: [
        repo(activeUrl),
        repo("https://github.com/acme/other.git"),
      ],
      activeRepoUrl: "https://github.com/acme/other.git",
    });
    useSessionStore.setState({
      sessionId: "s1",
      sessions: [session("s1", activeUrl)],
    });
    openOverlay();

    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Quick capture" })).toBeInTheDocument();
    expect(screen.getByTestId("message-input")).toHaveAttribute("data-surface", "overlay");
    expect(screen.getByRole("combobox")).toHaveValue(activeUrl);
    expect(lastMessageInputProps?.surface).toBe("overlay");
    expect(lastMessageInputProps?.hasActiveSession).toBe(false);
  });

  it("resets the repo selector to the current session repo each time the overlay opens", () => {
    const firstUrl = "https://github.com/acme/first.git";
    const secondUrl = "https://github.com/acme/second.git";
    useRepoStore.setState({
      repos: [repo(firstUrl), repo(secondUrl)],
      activeRepoUrl: firstUrl,
    });
    useSessionStore.setState({
      sessionId: "s1",
      sessions: [session("s1", firstUrl), session("s2", secondUrl)],
    });
    openOverlay();

    const { rerender } = render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: secondUrl } });
    expect(screen.getByRole("combobox")).toHaveValue(secondUrl);

    useUiStore.setState({ quickCaptureOpen: false });
    rerender(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    openOverlay();
    rerender(<QuickCaptureOverlay onAddRepo={vi.fn()} />);

    expect(screen.getByRole("combobox")).toHaveValue(firstUrl);
  });

  it("shows a loading state and disables input until bootstrap has loaded", () => {
    useUiStore.setState({ quickCaptureOpen: true, bootstrapLoaded: false });

    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);

    expect(screen.getByText("Loading repos")).toBeInTheDocument();
    expect(screen.getByTestId("message-input")).toHaveAttribute("data-disabled", "true");
  });

  it("opens the add-repo flow when no repo exists", () => {
    const onAddRepo = vi.fn();
    openOverlay();

    render(<QuickCaptureOverlay onAddRepo={onAddRepo} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a repo first" }));

    expect(onAddRepo).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().quickCaptureOpen).toBe(false);
  });

  it("submits to the headless-session action and closes without changing sessions", async () => {
    useRepoStore.setState({
      repos: [repo("https://github.com/acme/app.git")],
      activeRepoUrl: "https://github.com/acme/app.git",
    });
    useSessionStore.setState({ sessionId: "current", sessions: [session("current", "https://github.com/acme/app.git")] });
    createHeadlessSessionMock.mockResolvedValue(session("quick", "https://github.com/acme/app.git"));
    openOverlay();

    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send mock" }));

    await waitFor(() => expect(createHeadlessSessionMock).toHaveBeenCalledWith({
      repoUrl: "https://github.com/acme/app.git",
      initialPrompt: "captured prompt",
      agent: "claude",
    }));
    await waitFor(() => expect(useUiStore.getState().quickCaptureOpen).toBe(false));
    expect(useSessionStore.getState().sessionId).toBe("current");
  });

  it("renders cap and generic submission errors inline", async () => {
    useRepoStore.setState({
      repos: [repo("https://github.com/acme/app.git")],
      activeRepoUrl: "https://github.com/acme/app.git",
    });
    createHeadlessSessionMock.mockRejectedValue(new Error("You already have 8 quick sessions running."));
    openOverlay();

    const { rerender } = render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send mock" }));
    expect(await screen.findByText("You already have 8 quick sessions running.")).toBeInTheDocument();

    createHeadlessSessionMock.mockRejectedValueOnce(new Error("Couldn't start a session — try again"));
    fireEvent.click(screen.getByRole("button", { name: "Send mock" }));
    rerender(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    expect(await screen.findByText("Couldn't start a session — try again")).toBeInTheDocument();
  });

  it("restores focus and selection to the chat textarea when dismissed", async () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.setSelectionRange(2, 7);
    openOverlay();

    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close quick capture" }));

    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(7);
    textarea.remove();
  });
});
