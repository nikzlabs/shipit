import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StartSessionButton } from "./StartSessionButton.js";
import type { RepoInfo } from "../../server/shared/types.js";

function repo(url: string, over: Partial<RepoInfo> = {}): RepoInfo {
  return { url, addedAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z", status: "ready", ...over };
}

const TWO_REPOS = [
  repo("https://github.com/acme/shipit.git"),
  repo("https://github.com/acme/website.git"),
];

describe("StartSessionButton", () => {
  it("renders the default label and fires onClick", () => {
    const onClick = vi.fn();
    render(<StartSessionButton onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("supports a custom label and the disabled state", () => {
    const onClick = vi.fn();
    render(<StartSessionButton label="Start session from this issue" disabled onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /start session from this issue/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to the calm cta tint but renders solid primary when asked", () => {
    const { rerender } = render(<StartSessionButton onClick={vi.fn()} />);
    // Default: the subtle accent-tint cta used down the Issues list.
    expect(screen.getByRole("button")).toHaveClass("bg-(--color-accent-subtle)");
    // The detail footer overrides to a solid primary fill.
    rerender(<StartSessionButton variant="primary" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveClass("bg-(--color-accent)");
  });
});

// docs/236: an issue often belongs to a project other than the session you're
// sitting in, so the button splits into "start here" + "start in…".
describe("StartSessionButton repo picker (docs/236)", () => {
  it("stays a plain button when there is nothing to choose between", () => {
    const { rerender } = render(
      <StartSessionButton onClick={vi.fn()} repos={TWO_REPOS} />,
    );
    // No `onStartInRepo` — every pre-existing call site keeps one button.
    expect(screen.getAllByRole("button")).toHaveLength(1);

    // One repo is not a choice either.
    rerender(
      <StartSessionButton
        onClick={vi.fn()}
        repos={[TWO_REPOS[0]!]}
        onStartInRepo={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("starts in the picked repo without firing the default-target click", async () => {
    const onClick = vi.fn();
    const onStartInRepo = vi.fn();
    render(
      <StartSessionButton
        onClick={onClick}
        repos={TWO_REPOS}
        targetRepoUrl={TWO_REPOS[0]!.url}
        onStartInRepo={onStartInRepo}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /start session in another repository/i }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: /website/i }));

    expect(onStartInRepo).toHaveBeenCalledWith(TWO_REPOS[1]!.url);
    // The main half is the one-click default path; opening the menu must not
    // also seed a session in the repo the user is trying to leave.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps the main half a single click for the default repo", () => {
    const onClick = vi.fn();
    const onStartInRepo = vi.fn();
    render(
      <StartSessionButton
        onClick={onClick}
        repos={TWO_REPOS}
        targetRepoUrl={TWO_REPOS[0]!.url}
        onStartInRepo={onStartInRepo}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^start session$/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onStartInRepo).not.toHaveBeenCalled();
  });

  it("does not offer a repo that is still cloning", async () => {
    const onStartInRepo = vi.fn();
    render(
      <StartSessionButton
        onClick={vi.fn()}
        repos={[TWO_REPOS[0]!, repo("https://github.com/acme/fresh.git", { status: "cloning" })]}
        targetRepoUrl={TWO_REPOS[0]!.url}
        onStartInRepo={onStartInRepo}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /start session in another repository/i }),
    );
    // A claim against a still-cloning repo 400s server-side, so the row is
    // rendered (so the user sees the repo exists) but not selectable.
    expect(await screen.findByRole("menuitem", { name: /fresh/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("disables both halves when no repo is available", () => {
    render(
      <StartSessionButton
        onClick={vi.fn()}
        disabled
        repos={TWO_REPOS}
        onStartInRepo={vi.fn()}
      />,
    );
    for (const btn of screen.getAllByRole("button")) expect(btn).toBeDisabled();
  });
});
