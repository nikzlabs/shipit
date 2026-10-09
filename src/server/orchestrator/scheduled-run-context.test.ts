import { describe, expect, it } from "vitest";
import type { Schedule, ScheduleRun, SessionInfo } from "../shared/types.js";
import { RUN_NOTES_CONTAINER_DIR, ScheduleNotes } from "./schedule-notes.js";
import { renderScheduledRunBlock, scheduledRunContext, type ScheduledRunContextDeps } from "./scheduled-run-context.js";

const SCHEDULE = { id: "sched-1", name: "Security PRs", timeZone: "Europe/Berlin" } as Schedule;
const RUN = { id: "run-1", scheduleId: "sched-1", slotAt: "2026-10-07T07:00:00.000Z", createdAt: "x" } as ScheduleRun;
const RUN_SESSION = { id: "s1", scheduleId: "sched-1", scheduleRunId: "run-1" } as SessionInfo;

function deps(over: Partial<ScheduledRunContextDeps> = {}, session: SessionInfo | undefined = RUN_SESSION): ScheduledRunContextDeps {
  return {
    sessionManager: { get: () => session },
    store: { get: (id) => (id === SCHEDULE.id ? SCHEDULE : null), getRun: (id) => (id === RUN.id ? RUN : null) },
    notes: new ScheduleNotes("/workspace/schedules"),
    runtimeMode: "containerized",
    ...over,
  };
}

describe("scheduledRunContext — the run's first-turn block (docs/324 req 13)", () => {
  it("rides only the dispatch whose delivery id is the run's own", () => {
    const block = scheduledRunContext(deps(), "s1", "run-1");
    expect(block.startsWith("<scheduled_run>")).toBe(true);
    expect(block.endsWith("</scheduled_run>")).toBe(true);
    expect(scheduledRunContext(deps(), "s1", undefined)).toBe("");
    expect(scheduledRunContext(deps(), "s1", "another-delivery")).toBe("");
    expect(scheduledRunContext(deps({}, { id: "s1" } as SessionInfo), "s1", "run-1")).toBe("");
  });

  it("names the schedule, the read command and the run's time in the schedule's zone", () => {
    const block = scheduledRunContext(deps(), "s1", "run-1");
    expect(block).toContain('"Security PRs"');
    expect(block).toContain("shipit schedule notes sched-1");
    expect(block).toContain("2026-10-07 09:00 (Europe/Berlin)");
    expect(block).toContain("/shipit-docs/untrusted-input.md");
  });

  it("gives the time in the run's own zone once the schedule's zone has changed, as its title does", () => {
    const run = { ...RUN, timeZone: "Asia/Tokyo" };
    const block = scheduledRunContext(deps({ store: { get: () => SCHEDULE, getRun: () => run } }), "s1", "run-1");
    expect(block).toContain("2026-10-07 16:00 (Asia/Tokyo)");
  });

  it("gives the container path, or the host path in local mode, where there is no container", () => {
    expect(scheduledRunContext(deps(), "s1", "run-1")).toContain(RUN_NOTES_CONTAINER_DIR);
    const local = scheduledRunContext(deps({ runtimeMode: "local" }), "s1", "run-1");
    expect(local).toContain("/workspace/schedules/sched-1/runs/run-1");
    expect(local).not.toContain(RUN_NOTES_CONTAINER_DIR);
  });

  it("is empty once the schedule or its run row is gone", () => {
    expect(scheduledRunContext(deps({ store: { get: () => null, getRun: () => RUN } }), "s1", "run-1")).toBe("");
    expect(scheduledRunContext(deps({ store: { get: () => SCHEDULE, getRun: () => null } }), "s1", "run-1")).toBe("");
  });

  it("fills every token", () => {
    expect(renderScheduledRunBlock({ name: "n", scheduleId: "x", runAt: "y", notesDir: "z" }))
      .not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it("keeps the name inside its quotes, and fills no token from it", () => {
    const block = renderScheduledRunBlock({ name: 'a "b" {{NOTES_DIR}}', scheduleId: "x", runAt: "y", notesDir: "z" });
    expect(block).toContain(String.raw`"a \"b\" {{NOTES_DIR}}"`);
  });
});
