import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionSelector, type SessionInfo } from "./SessionSelector.js";

function makeSession(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: "sess-1",
    title: "Test session",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SessionSelector", () => {
  const defaultProps = () => ({
    sessions: [] as SessionInfo[],
    currentSessionId: undefined as string | undefined,
    onResume: vi.fn(),
    onNew: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onRefresh: vi.fn(),
  });

  afterEach(cleanup);

  describe("dropdown toggle", () => {
    it("renders the Sessions button", () => {
      render(<SessionSelector {...defaultProps()} />);
      expect(screen.getByText("Sessions")).toBeInTheDocument();
    });

    it("opens the dropdown and calls onRefresh", () => {
      const props = defaultProps();
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(props.onRefresh).toHaveBeenCalledOnce();
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    it("shows empty state when no sessions", () => {
      render(<SessionSelector {...defaultProps()} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(screen.getByText(/No sessions yet/)).toBeInTheDocument();
    });

    it("closes on backdrop click", () => {
      render(<SessionSelector {...defaultProps()} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(screen.getByText("New Session")).toBeInTheDocument();

      // Click the backdrop (fixed inset-0 div)
      const backdrop = document.querySelector(".fixed.inset-0");
      expect(backdrop).not.toBeNull();
      fireEvent.click(backdrop!);
      expect(screen.queryByText("New Session")).not.toBeInTheDocument();
    });
  });

  describe("session list", () => {
    it("displays session titles", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "My project" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(screen.getByText("My project")).toBeInTheDocument();
    });

    it("highlights the current session", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Current one" })];
      props.currentSessionId = "s1";
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      // Current session text should include the bullet
      const titleEl = screen.getByText("Current one");
      expect(titleEl.className).toContain("emerald");
    });

    it("calls onResume when clicking a non-current session", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Other session" })];
      props.currentSessionId = "different";
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByText("Other session"));
      expect(props.onResume).toHaveBeenCalledWith("s1");
    });

    it("does not call onResume when clicking the current session", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Current" })];
      props.currentSessionId = "s1";
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByText("Current"));
      expect(props.onResume).not.toHaveBeenCalled();
    });
  });

  describe("new session", () => {
    it("calls onNew and closes dropdown", () => {
      const props = defaultProps();
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByText("New Session"));
      expect(props.onNew).toHaveBeenCalledOnce();
      expect(screen.queryByText("New Session")).not.toBeInTheDocument();
    });
  });

  describe("delete session", () => {
    it("shows delete button on non-current sessions", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Deletable" })];
      props.currentSessionId = "other";
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(screen.getByTitle("Delete session")).toBeInTheDocument();
    });

    it("hides delete button on the current session", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Current" })];
      props.currentSessionId = "s1";
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(screen.queryByTitle("Delete session")).not.toBeInTheDocument();
    });

    it("calls onDelete with session id", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "To delete" })];
      props.currentSessionId = "other";
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Delete session"));
      expect(props.onDelete).toHaveBeenCalledWith("s1");
    });
  });

  describe("rename session", () => {
    it("shows rename button on hover", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Renameable" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      expect(screen.getByTitle("Rename session")).toBeInTheDocument();
    });

    it("enters edit mode when rename button is clicked", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Old name" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Rename session"));

      const input = screen.getByDisplayValue("Old name");
      expect(input).toBeInTheDocument();
      expect(input.tagName).toBe("INPUT");
    });

    it("submits rename on Enter", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Old name" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Rename session"));

      const input = screen.getByDisplayValue("Old name");
      fireEvent.change(input, { target: { value: "New name" } });
      fireEvent.submit(input.closest("form")!);

      expect(props.onRename).toHaveBeenCalledWith("s1", "New name");
    });

    it("submits rename on blur", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Old name" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Rename session"));

      const input = screen.getByDisplayValue("Old name");
      fireEvent.change(input, { target: { value: "Blurred name" } });
      fireEvent.blur(input);

      expect(props.onRename).toHaveBeenCalledWith("s1", "Blurred name");
    });

    it("cancels editing on Escape without calling onRename", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Keep me" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Rename session"));

      const input = screen.getByDisplayValue("Keep me");
      fireEvent.change(input, { target: { value: "Changed" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(props.onRename).not.toHaveBeenCalled();
      // Should return to showing the session title
      expect(screen.getByText("Keep me")).toBeInTheDocument();
    });

    it("does not call onRename for empty input", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Has title" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Rename session"));

      const input = screen.getByDisplayValue("Has title");
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.submit(input.closest("form")!);

      expect(props.onRename).not.toHaveBeenCalled();
    });

    it("cancels editing when backdrop is clicked (does not save)", () => {
      const props = defaultProps();
      props.sessions = [makeSession({ id: "s1", title: "Original" })];
      render(<SessionSelector {...props} />);
      fireEvent.click(screen.getByText("Sessions"));
      fireEvent.click(screen.getByTitle("Rename session"));

      const input = screen.getByDisplayValue("Original");
      fireEvent.change(input, { target: { value: "Should not save" } });

      // Click backdrop
      const backdrop = document.querySelector(".fixed.inset-0");
      fireEvent.click(backdrop!);

      expect(props.onRename).not.toHaveBeenCalled();
    });
  });
});
