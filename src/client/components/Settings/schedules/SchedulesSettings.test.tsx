import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchedulesSettings } from "./SchedulesSettings.js";
import { useScheduleStore } from "../../../stores/schedule-store.js";
import { useSessionStore } from "../../../stores/session-store.js";
import { useScheduleNotesStore } from "../../../stores/schedule-notes-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { browserTimeZone, formatRunTime } from "./schedule-format.js";
import type {
  ScheduleRunView,
  ScheduleView,
  SessionListRow,
  UnfinishedScheduleRun,
} from "../../../../server/shared/types.js";

/**
 * docs/324-scheduled-sessions — Settings → Schedules: the list (req 10), the runs with their
 * states (req 24), Run now and its warning (req 26), Pause / Resume (req 19), Delete and its
 * refusal (req 32), and Stop (req 33).
 */

function schedule(id: string, over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id,
    name: `Sweep ${id}`,
    enabled: true,
    timing: { kind: "weekdays", hour: 9, minute: 0 },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    spec: {
      target: { kind: "sandbox", capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: true } },
      params: { permissionMode: "plan" },
      prompt: "Check the security PRs.",
    },
    activeSince: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRuns: ["2026-10-08T09:00:00.000Z"],
    ...over,
  };
}

function session(id: string, over: Partial<SessionListRow> = {}): SessionListRow {
  return { id, title: id, createdAt: "", lastUsedAt: "", remoteUrl: "", scheduleId: "a", ...over };
}

function run(id: string, over: Partial<ScheduleRunView> = {}): ScheduleRunView {
  return { id, scheduleId: "a", slotAt: "2026-10-07T09:00:00.000Z", outcome: "started", createdAt: "2026-10-07T09:00:00.000Z", ...over };
}

let calls: { method: string; url: string }[];
let unfinished: UnfinishedScheduleRun[];
let runs: ScheduleRunView[];
let deleted: boolean;

function stubServer() {
  calls = [];
  deleted = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
    if (deleted) return { ok: false, status: 404, json: async () => ({ error: "Schedule not found" }) };
    if (url.endsWith("/unfinished-runs")) return ok({ runs: unfinished });
    if (url.includes("/runs?")) return ok({ runs });
    if (url.endsWith("/run")) return ok({ run: run("new", { outcome: "starting", slotAt: null }) }, 202);
    if (url.endsWith("/pause")) return ok({ schedule: schedule("a", { enabled: false }) });
    if (url.endsWith("/resume")) return ok({ schedule: schedule("a") });
    if (url.includes("/stop")) {
      unfinished = unfinished.filter((r) => !url.includes(r.runId));
      return ok({ run: null });
    }
    if (method === "DELETE") {
      deleted = true;
      return { ok: true, status: 204, json: async () => undefined };
    }
    return { ok: false, status: 404, json: async () => ({ error: `unexpected ${method} ${url}` }) };
  }));
}

const posted = (suffix: string) => calls.some((c) => c.method === "POST" && c.url.endsWith(suffix));

beforeEach(() => {
  vi.unstubAllGlobals();
  stubServer();
  unfinished = [];
  runs = [];
  useScheduleStore.getState().reset();
  useScheduleStore.setState({ schedules: [schedule("a")], loaded: true });
  useSessionStore.setState({ sessions: [], activeRunnerSessions: new Set() });
  useUiStore.setState({ settingsScheduleId: null, toast: null });
});

describe("SchedulesSettings — the list (reqs 10, 18)", () => {
  it("shows each schedule's name, when it runs, its target, what it runs as, and its state", () => {
    useScheduleStore.setState({
      schedules: [
        schedule("a"),
        schedule("b", { enabled: false, needsUserReason: "The repository is not trusted." }),
      ],
    });
    render(<SchedulesSettings />);

    const a = screen.getByTestId("schedule-a");
    expect(a.textContent).toContain("Sweep a");
    expect(a.textContent).toContain("Weekdays at 09:00");
    expect(a.textContent).toContain("Sandbox · GitHub, Merge PRs, Network");
    expect(a.textContent).toContain("Plan");
    expect(within(a).queryByTestId("schedule-paused-a")).toBeNull();
    expect(screen.getByTestId("schedule-paused-b")).toBeTruthy();
    expect(screen.getByTestId("schedule-needs-user-b").textContent).toContain("The repository is not trusted.");
    expect(screen.getByTestId("schedule-pause-b").textContent).toContain("Resume");
  });

  it("says how to make one when there is none (req 8)", () => {
    useScheduleStore.setState({ schedules: [] });
    render(<SchedulesSettings />);
    expect(screen.getByTestId("schedules-empty").textContent).toContain("Ask the agent");
  });

  it("opens at the schedule it was asked to open, with its runs shown", async () => {
    useScheduleStore.setState({ schedules: [schedule("a"), schedule("b")] });
    useUiStore.setState({ settingsScheduleId: "b" });
    render(<SchedulesSettings />);
    expect(await screen.findByTestId("schedule-runs-empty-b")).toBeTruthy();
    expect(screen.queryByTestId("schedule-runs-empty-a")).toBeNull();
  });
});

describe("SchedulesSettings — Run now (req 26)", () => {
  it("starts a run at once when every run is finished", async () => {
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-run-now-a"));
    await waitFor(() => expect(posted("/api/schedules/a/run")).toBe(true));
    expect(screen.queryByTestId("schedule-run-now-warning")).toBeNull();
  });

  it("warns first, listing the runs that are not finished; Cancel starts nothing, Run anyway starts one", async () => {
    unfinished = [
      { runId: "r1", sessionId: "s1", title: "Sweep a · Oct 6, 09:00" },
      { runId: "r2", sessionId: "s2", title: "Sweep a · Oct 5, 09:00", archived: true },
    ];
    render(<SchedulesSettings />);

    await userEvent.click(screen.getByTestId("schedule-run-now-a"));
    const warning = await screen.findByTestId("schedule-run-now-warning");
    expect(warning.textContent).toContain("Sweep a · Oct 6, 09:00");
    expect(warning.textContent).toContain("archived");
    await userEvent.click(screen.getByTestId("schedule-run-now-cancel"));
    expect(posted("/run")).toBe(false);

    await userEvent.click(screen.getByTestId("schedule-run-now-a"));
    await userEvent.click(await screen.findByTestId("schedule-run-anyway"));
    await waitFor(() => expect(posted("/api/schedules/a/run")).toBe(true));
  });
});

describe("SchedulesSettings — Pause and Resume (req 19)", () => {
  it("pauses a running schedule and resumes a paused one", async () => {
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-pause-a"));
    await waitFor(() => expect(posted("/api/schedules/a/pause")).toBe(true));
    expect(await screen.findByTestId("schedule-paused-a")).toBeTruthy();

    await userEvent.click(screen.getByTestId("schedule-pause-a"));
    await waitFor(() => expect(posted("/api/schedules/a/resume")).toBe(true));
  });
});

describe("SchedulesSettings — Delete (req 32)", () => {
  async function openDelete() {
    await userEvent.click(screen.getByRole("button", { name: "More for Sweep a" }));
    await userEvent.click(await screen.findByTestId("schedule-delete-a"));
    return screen.findByTestId("schedule-delete-dialog");
  }

  it("is refused while a run is not finished, lists each run with Stop, and allows Delete once they have wound down", async () => {
    unfinished = [
      { runId: "r1", sessionId: "s1", title: "Sweep a · Oct 6, 09:00" },
      { runId: "r2", sessionId: "s2", title: "Sweep a · Oct 5, 09:00", stopping: true },
    ];
    useSessionStore.setState({ sessions: [session("s1"), session("s2", { runStoppedAt: "2026-10-07T10:00:00.000Z" })] });
    render(<SchedulesSettings />);
    await openDelete();

    const refused = await screen.findByTestId("schedule-delete-refused");
    expect(refused.textContent).toContain("Sweep a · Oct 6, 09:00");
    expect(refused.textContent).toContain("stopping…");
    expect(screen.queryByTestId("schedule-unfinished-stop-r2")).toBeNull();
    expect(screen.getByTestId("schedule-delete-confirm")).toBeDisabled();

    await userEvent.click(screen.getByTestId("schedule-unfinished-stop-r1"));
    await waitFor(() => expect(posted("/api/schedules/a/runs/r1/stop")).toBe(true));
    expect(screen.getByTestId("schedule-delete-confirm")).toBeDisabled();

    // The stopped run winds down while the dialog is open.
    unfinished = [];
    useSessionStore.setState({
      sessions: [session("s1"), session("s2", { runStoppedAt: "2026-10-07T10:00:00.000Z", runFinishedAt: "2026-10-07T10:01:00.000Z" })],
    });
    await waitFor(() => expect(screen.getByTestId("schedule-delete-confirm")).toBeEnabled());
    await userEvent.click(screen.getByTestId("schedule-delete-confirm"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/schedules/a")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("schedule-a")).toBeNull());
    // Nothing reads the list behind a delete that went through.
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("asks again while an archived stopped run winds down, which no session list shows", async () => {
    unfinished = [{ runId: "r2", sessionId: "s2", title: "Sweep a · Oct 5, 09:00", archived: true, stopping: true }];
    render(<SchedulesSettings />);
    await openDelete();
    expect((await screen.findByTestId("schedule-delete-refused")).textContent).toContain("stopping…");

    unfinished = [];
    await waitFor(() => expect(screen.getByTestId("schedule-delete-confirm")).toBeEnabled(), { timeout: 5000 });
  });
});

describe("SchedulesSettings — runs (reqs 24, 33)", () => {
  it("lists the runs in the server's newest-first order with their state and result, and offers Stop and Open where they apply", async () => {
    const day = (d: number) => `2026-10-0${d}T09:00:00.000Z`;
    runs = [
      run("going", { sessionId: "s-going", slotAt: day(7) }),
      run("asking", { sessionId: "s-asking", slotAt: day(6), result: "Merged #3051; asked about #3060." }),
      run("done", { sessionId: "s-done", slotAt: day(5), result: "Merged 2 security PRs.", session: session("s-done", { runFinishedAt: "2026-10-05T09:40:00.000Z" }) }),
      run("skipped", { outcome: "skipped", slotAt: day(4), reason: "The previous run was still going." }),
      run("gone", { sessionId: "s-gone", slotAt: day(3), sessionDeleted: true, result: "Nothing to merge.", hasNotes: true }),
    ];
    useSessionStore.setState({
      sessions: [session("s-going"), session("s-asking", { awaitingAnswer: true })],
      activeRunnerSessions: new Set(["s-going"]),
    });
    const onOpenSession = vi.fn();
    render(<SchedulesSettings onOpenSession={onOpenSession} />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await screen.findByTestId("schedule-runs-a");

    expect([...screen.getByTestId("schedule-runs-a").querySelectorAll("li")].map((li) => li.dataset.testid))
      .toEqual(["going", "asking", "done", "skipped", "gone"].map((id) => `schedule-run-${id}`));
    const state = (id: string) => screen.getByTestId(`schedule-run-state-${id}`).textContent;
    expect(state("going")).toBe("Running");
    expect(state("asking")).toBe("Needs you");
    expect(state("done")).toBe("Finished");
    expect(state("skipped")).toBe("Skipped");
    expect(state("gone")).toBe("Session deleted");
    expect(screen.getByTestId("schedule-run-asking").textContent).toContain("asked about #3060");
    expect(screen.getByTestId("schedule-run-skipped").textContent).toContain("The previous run was still going.");

    expect(screen.queryByTestId("schedule-run-stop-done")).toBeNull();
    expect(screen.queryByTestId("schedule-run-stop-skipped")).toBeNull();
    expect(screen.queryByTestId("schedule-run-open-gone")).toBeNull();

    await userEvent.click(screen.getByTestId("schedule-run-stop-going"));
    await waitFor(() => expect(posted("/api/schedules/a/runs/going/stop")).toBe(true));

    await userEvent.click(screen.getByTestId("schedule-run-open-done"));
    expect(onOpenSession).toHaveBeenCalledWith("s-done");

    // Notes outlive the session, and a run with no folder offers none (req 27).
    const open = vi.fn();
    useScheduleNotesStore.setState({ open });
    expect(screen.queryByTestId("schedule-run-notes-skipped")).toBeNull();
    await userEvent.click(screen.getByTestId("schedule-run-notes-gone"));
    expect(open).toHaveBeenCalledWith({ scheduleId: "a", runId: "gone" });
  });

  it("gives run times in the schedule's zone, as the run titles do, and names a zone that is not the browser's", async () => {
    const slotAt = "2026-10-07T09:00:00.000Z";
    runs = [run("r1", { outcome: "skipped", slotAt })];
    const { unmount } = render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await screen.findByTestId("schedule-runs-a");
    expect(screen.getByTestId("schedule-run-r1").textContent).toContain(formatRunTime(slotAt));
    expect(screen.queryByTestId("schedule-runs-zone-a")).toBeNull();
    unmount();

    const zone = browserTimeZone() === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
    const askedAt = "2026-10-07T11:30:00.000Z";
    runs = [
      run("r1", { outcome: "skipped", slotAt }),
      run("live", { sessionId: "s-live", slotAt }),
      run("kept", { sessionId: "s-kept", slotAt, session: session("s-kept", { runFinishedAt: "x" }) }),
      run("asked", { slotAt: null, createdAt: askedAt }),
    ];
    useSessionStore.setState({ sessions: [session("s-live")] });
    useScheduleStore.setState({ schedules: [schedule("a", { timeZone: zone })] });
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await screen.findByTestId("schedule-runs-a");
    for (const id of ["r1", "live", "kept"]) {
      expect(screen.getByTestId(`schedule-run-${id}`).textContent).toContain(formatRunTime(slotAt, zone));
    }
    // Run now has no slot; it is named by when it was asked for.
    expect(screen.getByTestId("schedule-run-asked").textContent).toContain(formatRunTime(askedAt, zone));
    expect(formatRunTime(slotAt, zone)).not.toBe(formatRunTime(slotAt));
    expect(screen.getByTestId("schedule-runs-zone-a").textContent).toBe(`Times in ${zone}, the schedule’s time zone.`);
  });

  it("reads the runs again when a run's turn ends, so its result line is current", async () => {
    runs = [run("going", { sessionId: "s-going" })];
    useSessionStore.setState({ sessions: [session("s-going")], activeRunnerSessions: new Set(["s-going"]) });
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await screen.findByTestId("schedule-runs-a");
    const reads = () => calls.filter((c) => c.url.includes("/runs?")).length;
    const before = reads();

    useSessionStore.setState({ activeRunnerSessions: new Set() });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("reads the runs again after a Stop: an archived run's session is in no list the browser follows", async () => {
    runs = [run("old", { sessionId: "s-old", session: session("s-old", { userArchived: true }) })];
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await screen.findByTestId("schedule-runs-a");

    runs = [run("old", { sessionId: "s-old", session: session("s-old", { userArchived: true, runStoppedAt: "x", runFinishedAt: "x" }) })];
    await userEvent.click(screen.getByTestId("schedule-run-stop-old"));
    await waitFor(() => expect(screen.getByTestId("schedule-run-state-old").textContent).toBe("Stopped"));
    expect(screen.queryByTestId("schedule-run-stop-old")).toBeNull();
  });

  it("reads one page more on Show older runs", async () => {
    runs = Array.from({ length: 50 }, (_, i) => run(`r${i}`, { outcome: "skipped" }));
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await userEvent.click(await screen.findByTestId("schedule-runs-older-a"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/schedules/a/runs?limit=100")).toBe(true));
  });

  it("reads the runs again when a run's session changes", async () => {
    runs = [run("going", { sessionId: "s-going" })];
    useSessionStore.setState({ sessions: [session("s-going")] });
    render(<SchedulesSettings />);
    await userEvent.click(screen.getByTestId("schedule-toggle-a"));
    await screen.findByTestId("schedule-runs-a");
    const reads = () => calls.filter((c) => c.url.includes("/runs?")).length;
    const before = reads();

    useSessionStore.setState({ sessions: [session("s-going", { awaitingAnswer: true })] });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});
