import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import { ScheduleNotesViewer } from "./ScheduleNotesViewer.js";
import { openScheduleNotes, useScheduleNotesStore } from "../stores/schedule-notes-store.js";
import type { ScheduleNoteContent, ScheduleRunNotes } from "../../server/shared/types.js";

const NOTES_URL = "/api/schedules/sched-1/runs/run-1/notes";

const notes = (over: Partial<ScheduleRunNotes> = {}): ScheduleRunNotes => ({
  scheduleId: "sched-1",
  scheduleName: "Nightly triage",
  runId: "run-1",
  runAt: "2026-10-07T07:00:00.000Z",
  files: [
    { path: "summary.md", size: 120, modifiedAt: "2026-10-07T07:05:00.000Z" },
    { path: "logs/raw.txt", size: 2048, modifiedAt: "2026-10-07T07:05:00.000Z" },
    { path: "chart.png", size: 5000, modifiedAt: "2026-10-07T07:05:00.000Z" },
  ],
  ...over,
});

const FILES: Record<string, ScheduleNoteContent> = {
  "summary.md": { path: "summary.md", size: 120, text: "# Findings\n\n- **two** PRs need review" },
  "logs/raw.txt": { path: "logs/raw.txt", size: 2048, text: "# not a heading\nline two", truncated: true },
  "chart.png": { path: "chart.png", size: 5000 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn();

function serve(list: ScheduleRunNotes | { status: number; error: string }) {
  fetchMock.mockImplementation((input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname.endsWith("/notes")) {
      return Promise.resolve("status" in list ? json({ error: list.error }, list.status) : json({ notes: list }));
    }
    if (url.pathname.endsWith("/notes/file")) {
      const file = FILES[url.searchParams.get("path") ?? ""];
      return Promise.resolve(file ? json({ file }) : json({ error: "No such notes file." }, 404));
    }
    return Promise.resolve(json({ error: "unexpected" }, 500));
  });
}

async function openViewer() {
  render(<ScheduleNotesViewer />);
  await act(async () => {
    openScheduleNotes("sched-1", "run-1");
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  act(() => useScheduleNotesStore.getState().close());
  vi.unstubAllGlobals();
});

describe("ScheduleNotesViewer (docs/324-scheduled-sessions req 27)", () => {
  it("stays closed until a run is opened", () => {
    render(<ScheduleNotesViewer />);
    expect(screen.queryByTestId("schedule-notes-viewer")).not.toBeInTheDocument();
  });

  it("lists the run's files and shows the first, a markdown file, through the chat's renderer", async () => {
    serve(notes());
    await openViewer();

    expect(fetchMock).toHaveBeenCalledWith(NOTES_URL, expect.anything());
    const viewer = await screen.findByTestId("schedule-notes-viewer");
    expect(within(viewer).getByRole("heading", { name: "Nightly triage" })).toBeInTheDocument();
    expect(viewer).toHaveTextContent(`Notes of the run at ${new Date("2026-10-07T07:00:00.000Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);

    const list = screen.getByRole("navigation", { name: "Notes files" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "summary.md120 B",
      "logs/raw.txt2.0 KB",
      "chart.png4.9 KB",
    ]);
    expect(within(list).getByRole("button", { name: /summary\.md/ })).toHaveAttribute("aria-current", "true");

    const file = await screen.findByTestId("schedule-notes-file");
    expect(within(file).getByTestId("markdown-content")).toBeInTheDocument();
    expect(within(file).getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(within(file).getByText("two").tagName).toBe("STRONG");
  });

  it("shows another text file as preformatted text, and says when only its start is shown", async () => {
    serve(notes());
    await openViewer();
    await screen.findByTestId("markdown-content");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /logs\/raw\.txt/ }));
    });

    const file = await screen.findByTestId("schedule-notes-file");
    const pre = file.querySelector("pre");
    expect(pre?.textContent).toBe("# not a heading\nline two");
    expect(within(file).queryByRole("heading")).not.toBeInTheDocument();
    expect(file).toHaveTextContent("Only the start of this file is shown.");
    expect(fetchMock).toHaveBeenCalledWith(`${NOTES_URL}/file?path=logs%2Fraw.txt`, expect.anything());
  });

  it("shows a file that is not text by name and size only", async () => {
    serve(notes());
    await openViewer();
    await screen.findByTestId("markdown-content");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /chart\.png/ }));
    });

    const file = await screen.findByTestId("schedule-notes-file");
    expect(file).toHaveTextContent("chart.png4.9 KB · Not a text file");
    expect(file.querySelector("pre")).toBeNull();
    expect(within(file).queryByTestId("markdown-content")).not.toBeInTheDocument();
  });

  it("says when the run wrote no notes", async () => {
    serve(notes({ files: [] }));
    await openViewer();
    expect(await screen.findByText("This run wrote no notes.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call a folder empty when its files lie deeper than the listing goes", async () => {
    serve(notes({ files: [], truncated: true }));
    await openViewer();
    expect(await screen.findByText("This run's files lie deeper in its folder than this view lists.")).toBeInTheDocument();
    expect(screen.queryByText("This run wrote no notes.")).not.toBeInTheDocument();
  });

  it("shows the server's words when the notes are gone", async () => {
    serve({ status: 404, error: "That schedule no longer exists." });
    await openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("That schedule no longer exists.");
  });

  it("ignores a list that arrives after the viewer moved to another run", async () => {
    let answerFirst: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answerFirst = resolve; }));
    render(<ScheduleNotesViewer />);
    await act(async () => {
      openScheduleNotes("sched-1", "run-1");
    });

    serve(notes({ runId: "run-2", scheduleName: "Second schedule", files: [] }));
    await act(async () => {
      openScheduleNotes("sched-1", "run-2");
    });
    await screen.findByText("This run wrote no notes.");

    await act(async () => {
      answerFirst(json({ notes: notes() }));
    });
    expect(screen.getByRole("heading", { name: "Second schedule" })).toBeInTheDocument();
    expect(screen.getByText("This run wrote no notes.")).toBeInTheDocument();
  });
});
