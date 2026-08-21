import { describe, it, expect } from "vitest";
import { foldTaskList } from "./task-list.js";
import type { ChatMessage, ToolUseBlock, ToolResultBlock } from "./MessageList.js";

function tool(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function result(toolUseId: string, content: string): ToolResultBlock {
  return { toolUseId, content };
}

function msg(
  toolUse: ToolUseBlock[],
  toolResults: ToolResultBlock[] = [],
  text = "",
): ChatMessage {
  return { role: "assistant", text, toolUse, toolResults };
}

/** What the CLI returns from a TaskCreate — the only place the id appears. */
function created(id: string, subject: string): string {
  return `Task #${id} created successfully: ${subject}`;
}

describe("foldTaskList", () => {
  it("returns null when the transcript has no task calls", () => {
    expect(foldTaskList([])).toBeNull();
    expect(foldTaskList([msg([tool("t1", "Bash", { command: "ls" })])])).toBeNull();
  });

  it("builds the list from consecutive TaskCreate calls, in call order", () => {
    const state = foldTaskList([
      msg(
        [
          tool("t1", "TaskCreate", { subject: "Read the code", description: "..." }),
          tool("t2", "TaskCreate", { subject: "Write the fix", description: "..." }),
        ],
        [result("t1", created("1", "Read the code")), result("t2", created("2", "Write the fix"))],
      ),
    ]);
    expect(state?.tasks).toEqual([
      { id: "1", subject: "Read the code", status: "pending" },
      { id: "2", subject: "Write the fix", status: "pending" },
    ]);
  });

  it("keys a created task by the id in its RESULT, so TaskUpdate can find it", () => {
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "Run tests", activeForm: "Running tests" })],
        [result("t1", created("7", "Run tests"))]),
      msg([tool("t2", "TaskUpdate", { taskId: "7", status: "in_progress" })]),
    ]);
    expect(state?.tasks).toEqual([
      { id: "7", subject: "Run tests", activeForm: "Running tests", status: "in_progress" },
    ]);
  });

  it("gives a create still awaiting its result a provisional id", () => {
    // Mid-turn: the call is on the wire, the result is not. The row has to show
    // now, and settle onto its real id when the result lands.
    const inFlight = foldTaskList([msg([tool("t1", "TaskCreate", { subject: "Ship it" })])]);
    expect(inFlight?.tasks).toEqual([{ id: "pending-t1", subject: "Ship it", status: "pending" }]);

    const settled = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "Ship it" })], [result("t1", created("3", "Ship it"))]),
    ]);
    expect(settled?.tasks).toEqual([{ id: "3", subject: "Ship it", status: "pending" }]);
  });

  it("skips a create whose subject has not streamed in yet", () => {
    expect(foldTaskList([msg([tool("t1", "TaskCreate", {})])])).toBeNull();
  });

  it("patches subject, activeForm and status without losing the untouched fields", () => {
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "Old name", activeForm: "Doing old" })],
        [result("t1", created("1", "Old name"))]),
      msg([tool("t2", "TaskUpdate", { taskId: "1", status: "in_progress" })]),
      msg([tool("t3", "TaskUpdate", { taskId: "1", subject: "New name" })]),
    ]);
    expect(state?.tasks).toEqual([
      { id: "1", subject: "New name", activeForm: "Doing old", status: "in_progress" },
    ]);
  });

  it("removes a task on status deleted", () => {
    const state = foldTaskList([
      msg([tool("a", "TaskCreate", { subject: "Keep" })], [result("a", created("1", "Keep"))]),
      msg([tool("b", "TaskCreate", { subject: "Drop" })], [result("b", created("2", "Drop"))]),
      msg([tool("c", "TaskUpdate", { taskId: "2", status: "deleted" })]),
    ]);
    expect(state?.tasks).toEqual([{ id: "1", subject: "Keep", status: "pending" }]);
  });

  it("keeps a task's position when it is updated", () => {
    const state = foldTaskList([
      msg([
        tool("a", "TaskCreate", { subject: "First" }),
        tool("b", "TaskCreate", { subject: "Second" }),
      ], [result("a", created("1", "First")), result("b", created("2", "Second"))]),
      msg([tool("c", "TaskUpdate", { taskId: "1", status: "completed" })]),
    ]);
    expect(state?.tasks.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("adopts an update for a task whose create is no longer in the transcript", () => {
    // After a compaction the create can be gone while the update survives.
    // Dropping it would silently shrink the list.
    const state = foldTaskList([
      msg([tool("t1", "TaskUpdate", { taskId: "9", subject: "Survivor", status: "completed" })]),
    ]);
    expect(state?.tasks).toEqual([{ id: "9", subject: "Survivor", status: "completed" }]);
  });

  it("ignores an update it cannot name", () => {
    expect(foldTaskList([msg([tool("t1", "TaskUpdate", { taskId: "9", status: "completed" })])])).toBeNull();
  });

  it("still folds a legacy TodoWrite list", () => {
    // Sessions persisted before CLI 2.1.220 have TodoWrite in their history.
    const state = foldTaskList([
      msg([tool("t1", "TodoWrite", {
        todos: [
          { content: "Fix bug", status: "completed", activeForm: "Fixing bug" },
          { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
        ],
      })]),
    ]);
    expect(state?.tasks).toEqual([
      { id: "todo-0", subject: "Fix bug", activeForm: "Fixing bug", status: "completed" },
      { id: "todo-1", subject: "Add tests", activeForm: "Adding tests", status: "in_progress" },
    ]);
  });

  it("lets a TodoWrite replace the whole list, as its declarative form implies", () => {
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "Gone" })], [result("t1", created("1", "Gone"))]),
      msg([tool("t2", "TodoWrite", { todos: [{ content: "Only me", status: "pending", activeForm: "Doing" }] })]),
    ]);
    expect(state?.tasks).toEqual([
      { id: "todo-0", subject: "Only me", activeForm: "Doing", status: "pending" },
    ]);
  });

  it("patches by item id on a TodoWrite with merge: true, Grok's declarative-with-patch form", () => {
    // The docs/272 grok tour's exact shape (planning#437): one full-list call
    // with item ids, then merge calls carrying only {id, status}.
    const state = foldTaskList([
      msg([tool("t1", "TodoWrite", {
        todos: [
          { id: "1", content: "Read package.json", status: "in_progress" },
          { id: "2", content: "Run the probe", status: "pending" },
        ],
        merge: false,
      })]),
      msg([tool("t2", "TodoWrite", {
        todos: [{ id: "1", status: "completed" }, { id: "2", status: "in_progress" }],
        merge: true,
      })]),
    ]);
    // Subjects survive the content-less patch; only the statuses move.
    expect(state?.tasks).toEqual([
      { id: "1", subject: "Read package.json", status: "completed" },
      { id: "2", subject: "Run the probe", status: "in_progress" },
    ]);
    expect(state?.anchorIndex).toBe(1);
  });

  it("lets a merge call introduce a NEW row when it carries content", () => {
    const state = foldTaskList([
      msg([tool("t1", "TodoWrite", { todos: [{ id: "1", content: "First", status: "pending" }], merge: false })]),
      msg([tool("t2", "TodoWrite", { todos: [{ id: "2", content: "Second", status: "pending" }], merge: true })]),
    ]);
    expect(state?.tasks).toEqual([
      { id: "1", subject: "First", status: "pending" },
      { id: "2", subject: "Second", status: "pending" },
    ]);
  });

  it("skips a content-less patch for a row it never saw, and does not move the anchor for it", () => {
    // The compaction stance TaskUpdate takes: an id alone renders as a blank
    // line, so an orphan patch must neither add a row nor drag the panel down.
    const state = foldTaskList([
      msg([tool("t1", "TodoWrite", { todos: [{ id: "1", content: "Real", status: "pending" }], merge: false })]),
      msg([tool("t2", "TodoWrite", { todos: [{ id: "ghost", status: "completed" }], merge: true })]),
    ]);
    expect(state?.tasks).toEqual([{ id: "1", subject: "Real", status: "pending" }]);
    expect(state?.anchorIndex).toBe(0);
  });

  it("anchors on the last call that CHANGED the list", () => {
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "One" })], [result("t1", created("1", "One"))]),
      msg([tool("t2", "Bash", { command: "ls" })]),
      msg([tool("t3", "TaskUpdate", { taskId: "1", status: "completed" })]),
      msg([tool("t4", "Read", { file_path: "/a.ts" })]),
    ]);
    expect(state?.anchorIndex).toBe(2);
  });

  it("does not move the anchor for a read-only TaskList or TaskGet", () => {
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "One" })], [result("t1", created("1", "One"))]),
      msg([tool("t2", "TaskList", {})]),
      msg([tool("t3", "TaskGet", { taskId: "1" })]),
    ]);
    expect(state?.anchorIndex).toBe(0);
    expect(state?.tasks).toHaveLength(1);
  });

  it("finds a result recorded on a later message than its call", () => {
    // Tool results land in whichever message group is open when they arrive,
    // which is not always the one carrying the call.
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "Split" })]),
      msg([], [result("t1", created("4", "Split"))]),
    ]);
    expect(state?.tasks).toEqual([{ id: "4", subject: "Split", status: "pending" }]);
  });

  it("ignores a call the CLI rejected", () => {
    // A denied or failed call changed nothing, so neither may the panel.
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "Real" })], [result("t1", created("1", "Real"))]),
      msg([tool("t2", "TaskCreate", { subject: "Phantom" })],
        [{ toolUseId: "t2", content: "Permission denied", isError: true }]),
      msg([tool("t3", "TaskUpdate", { taskId: "1", status: "completed" })],
        [{ toolUseId: "t3", content: "No such task", isError: true }]),
    ]);
    expect(state?.tasks).toEqual([{ id: "1", subject: "Real", status: "pending" }]);
    expect(state?.anchorIndex).toBe(0);
  });

  it("does not move the anchor for an update that changes nothing yet", () => {
    // Mid-stream a TaskUpdate has only its taskId. Treating that as a change
    // would drag the panel down the transcript before anything had moved.
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "One" })], [result("t1", created("1", "One"))]),
      msg([tool("t2", "TaskUpdate", { taskId: "1" })]),
    ]);
    expect(state?.anchorIndex).toBe(0);
  });

  it("ignores a status the CLI never emits", () => {
    const state = foldTaskList([
      msg([tool("t1", "TaskCreate", { subject: "One" })], [result("t1", created("1", "One"))]),
      msg([tool("t2", "TaskUpdate", { taskId: "1", status: "banana" })]),
    ]);
    expect(state?.tasks[0].status).toBe("pending");
  });
});
