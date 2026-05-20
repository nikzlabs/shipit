import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PrConversationSection } from "./PrConversationSection.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { PrIssueComment, PrReviewThread } from "../../../server/shared/types/github-types.js";

afterEach(cleanup);

const comment: PrIssueComment = {
  id: "IC_1",
  author: { login: "alice", avatarUrl: "https://avatars/alice.png" },
  body: "Looks good to me",
  createdAt: "2026-05-20T10:00:00Z",
  url: "https://github.com/o/r/pull/1#issuecomment-1",
};

const thread: PrReviewThread = {
  id: "RT_1",
  isResolved: true,
  isOutdated: false,
  path: "src/x.ts",
  line: 12,
  comments: [
    { id: "RC_1", author: { login: "bob", avatarUrl: "" }, body: "nit: rename", createdAt: "2026-05-20T10:05:00Z" },
  ],
};

describe("PrConversationSection", () => {
  beforeEach(() => {
    // Default the store action to a no-op success so tests opt into behavior.
    usePrStore.setState({ postComment: vi.fn().mockResolvedValue(null) });
  });

  it("shows a loading hint when the conversation hasn't been fetched", () => {
    render(<PrConversationSection sessionId="s1" />);
    expect(screen.getByText(/Loading conversation/i)).toBeInTheDocument();
  });

  it("shows an empty state when fetched but with no comments", () => {
    render(<PrConversationSection sessionId="s1" issueComments={[]} reviewThreads={[]} />);
    expect(screen.getByText(/No comments yet/i)).toBeInTheDocument();
  });

  it("renders issue comments and read-only review threads", () => {
    render(
      <PrConversationSection sessionId="s1" issueComments={[comment]} reviewThreads={[thread]} />,
    );
    expect(screen.getByText("Looks good to me")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("src/x.ts:12")).toBeInTheDocument();
    expect(screen.getByText("resolved")).toBeInTheDocument();
    expect(screen.getByText("nit: rename")).toBeInTheDocument();
  });

  it("posts a comment through the store and clears the composer on success", async () => {
    const postComment = vi.fn().mockResolvedValue(null);
    usePrStore.setState({ postComment });

    render(<PrConversationSection sessionId="s1" issueComments={[]} reviewThreads={[]} />);
    const textarea = screen.getByPlaceholderText("Add a comment…") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Nice work" } });
    fireEvent.click(screen.getByText("Comment"));

    await waitFor(() => expect(postComment).toHaveBeenCalledWith("s1", "Nice work"));
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("surfaces an inline error banner when the post fails", async () => {
    usePrStore.setState({ postComment: vi.fn().mockResolvedValue("Not authenticated with GitHub") });

    render(<PrConversationSection sessionId="s1" issueComments={[]} reviewThreads={[]} />);
    fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hi" } });
    fireEvent.click(screen.getByText("Comment"));

    expect(await screen.findByText("Not authenticated with GitHub")).toBeInTheDocument();
  });

  it("disables the Comment button when the draft is empty", () => {
    render(<PrConversationSection sessionId="s1" issueComments={[]} reviewThreads={[]} />);
    expect(screen.getByText("Comment").closest("button")).toBeDisabled();
  });
});
