import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduledRunBanner, useAnyListSessionRow } from "./ScheduledRunBanner.js";
import { SandboxBanner } from "./SandboxBanner.js";
import { useScheduleStore } from "../stores/schedule-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useScheduleNotesStore } from "../stores/schedule-notes-store.js";
import { browserTimeZone, formatRunTime } from "./Settings/schedules/schedule-format.js";
import type { ScheduleView, SessionListRow } from "../../server/shared/types.js";

/**
 * docs/324-scheduled-sessions req 25 — a run's session says which schedule started it, links
 * back to it, and offers Stop while the run is not finished (req 33); after Delete it says so
 * and links nowhere (req 32).
 */

const SCHEDULE: ScheduleView = {
  id: "sched-1",
  name: "Security PR sweep",
  enabled: true,
  timing: { kind: "weekdays", hour: 9, minute: 0 },
  timeZone: "UTC",
  spec: null,
  activeSince: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRuns: [],
};

function runSession(over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: "s-1",
    title: "Security PR sweep · Oct 6, 09:00",
    createdAt: "2026-10-06T09:00:05.000Z",
    lastUsedAt: "2026-10-06T09:00:05.000Z",
    remoteUrl: "",
    scheduleId: "sched-1",
    scheduleRunId: "run-1",
    ...over,
  };
}

let posts: string[];

beforeEach(() => {
  vi.unstubAllGlobals();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") posts.push(url);
    return { ok: true, status: 200, json: async () => ({ run: null, sessions: [] }) };
  }));
  useScheduleStore.getState().reset();
  useScheduleStore.setState({ schedules: [SCHEDULE], loaded: true });
  useUiStore.setState({ settingsOpen: false, settingsTab: undefined, settingsScheduleId: null, bootstrapLoaded: true });
  useSessionStore.setState({ sessions: [], allSessions: [] });
});

describe("ScheduledRunBanner", () => {
  it("names the schedule and opens Settings → Schedules at it", async () => {
    render(<ScheduledRunBanner session={runSession()} />);
    expect(screen.getByTestId("scheduled-run-banner").textContent).toContain("Started by schedule Security PR sweep");

    await userEvent.click(screen.getByTestId("scheduled-run-open-schedule"));
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: "schedules", settingsScheduleId: "sched-1" });
  });

  it("stops the run while it is not finished, and offers no Stop once it is", async () => {
    const { rerender } = render(<ScheduledRunBanner session={runSession()} />);
    await userEvent.click(screen.getByTestId("scheduled-run-stop"));
    await waitFor(() => expect(posts).toEqual(["/api/schedules/sched-1/runs/run-1/stop"]));

    rerender(<ScheduledRunBanner session={runSession({ runFinishedAt: "2026-10-06T09:30:00.000Z" })} />);
    expect(screen.queryByTestId("scheduled-run-stop")).toBeNull();
    rerender(<ScheduledRunBanner session={runSession({ runStoppedAt: "2026-10-06T09:10:00.000Z" })} />);
    expect(screen.queryByTestId("scheduled-run-stop")).toBeNull();
  });

  it("gives a run from before runs kept their zone the time in the schedule's zone, and names a zone that is not the browser's", () => {
    const zone = browserTimeZone() === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
    const createdAt = runSession().createdAt;
    useScheduleStore.setState({ schedules: [{ ...SCHEDULE, timeZone: browserTimeZone() }] });
    const { rerender } = render(<ScheduledRunBanner session={runSession()} />);
    const banner = () => screen.getByTestId("scheduled-run-banner").textContent ?? "";
    expect(banner()).toContain(`· ${formatRunTime(createdAt)}`);
    expect(banner()).not.toContain("(");

    useScheduleStore.setState({ schedules: [{ ...SCHEDULE, timeZone: zone }] });
    rerender(<ScheduledRunBanner session={runSession()} />);
    expect(banner()).toContain(`· ${formatRunTime(createdAt, zone)} (${zone})`);
    expect(formatRunTime(createdAt, zone)).not.toBe(formatRunTime(createdAt));
  });

  it("keeps the run's own zone after the schedule's zone changes, so the time still reads as its title does", () => {
    const [made, changed] = ["Asia/Tokyo", "America/New_York", "Europe/Berlin"].filter((z) => z !== browserTimeZone()) as [string, string];
    // The title as `runTitle` writes it: the slot, in the zone the run was made in.
    const when = new Date("2026-10-06T09:00:00.000Z").toLocaleString("en-US", {
      timeZone: made, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const session = runSession({ title: `Security PR sweep · ${when}`, runTimeZone: made });
    const banner = () => screen.getByTestId("scheduled-run-banner").textContent ?? "";
    useScheduleStore.setState({ schedules: [{ ...SCHEDULE, timeZone: made }] });
    const { rerender } = render(<ScheduledRunBanner session={session} />);
    const before = banner();

    useScheduleStore.setState({ schedules: [{ ...SCHEDULE, timeZone: changed }] });
    rerender(<ScheduledRunBanner session={session} />);
    expect(banner()).toBe(before);
    expect(banner()).toContain(`· ${formatRunTime(session.createdAt, made)} (${made})`);
    const hourMinute = when.slice(-5);
    expect(banner()).toContain(hourMinute);
    expect(formatRunTime(session.createdAt, changed)).not.toContain(hourMinute);
  });

  it("opens the run's notes (req 27)", async () => {
    const open = vi.fn();
    useScheduleNotesStore.setState({ open });
    render(<ScheduledRunBanner session={runSession({ runFinishedAt: "2026-10-06T09:30:00.000Z" })} />);
    await userEvent.click(screen.getByTestId("scheduled-run-notes"));
    expect(open).toHaveBeenCalledWith({ scheduleId: "sched-1", runId: "run-1" });
  });

  it("says the schedule was deleted, with no links, and still gives the time in the run's zone", () => {
    useScheduleStore.setState({ schedules: [] });
    const { rerender } = render(<ScheduledRunBanner session={runSession()} />);
    const banner = () => screen.getByTestId("scheduled-run-banner").textContent ?? "";
    expect(banner()).toContain("Started by a schedule that was deleted");
    expect(screen.queryByRole("button")).toBeNull();

    const zone = browserTimeZone() === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
    rerender(<ScheduledRunBanner session={runSession({ runTimeZone: zone })} />);
    expect(banner()).toContain(`· ${formatRunTime(runSession().createdAt, zone)} (${zone})`);
  });

  it("shows nothing until the schedules are read, so a run is never taken for one of a deleted schedule", () => {
    useScheduleStore.setState({ schedules: [], loaded: false });
    const { container } = render(<ScheduledRunBanner session={runSession()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shares one bar with the sandbox banner in a sandbox run", () => {
    const { container } = render(
      <SandboxBanner
        capabilities={{ git: true, docker: false, network: true, dangerousGitHubOps: false }}
        run={runSession({ kind: "sandbox" })}
      />,
    );
    const bar = container.querySelector(".rounded-lg")!;
    expect(bar.textContent).toContain("Started by schedule Security PR sweep");
    expect(bar.textContent).toContain("Sandbox session");
    expect(container.querySelectorAll(".rounded-lg")).toHaveLength(1);
  });
});

describe("useAnyListSessionRow", () => {
  it("takes the row from the session list, then from the run history", () => {
    useScheduleStore.setState({
      runsBySchedule: {
        "sched-1": [{ id: "run-1", scheduleId: "sched-1", slotAt: null, outcome: "started", createdAt: "", sessionId: "s-1", session: runSession() }],
      },
    });
    expect(renderHook(() => useAnyListSessionRow("s-1")).result.current?.id).toBe("s-1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads All sessions for a session no list holds — an old run past the sidebar's cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessions: [runSession({ id: "s-old" })] }) })));
    const { result } = renderHook(() => useAnyListSessionRow("s-old"));
    await waitFor(() => expect(result.current?.scheduleId).toBe("sched-1"));
    expect(fetch).toHaveBeenCalledWith("/api/sessions/all", expect.anything());
  });
});
