import { describe, expect, it } from "vitest";
import { formatWhen } from "../../shared/schedule-describe.js";
import { parseScheduleProposal, parseWhen } from "./schedule-proposal-yaml.js";

describe("parseWhen", () => {
  it("reads the presets and a cron expression", () => {
    expect(parseWhen("hourly")).toEqual({ kind: "hourly", minute: 0 });
    expect(parseWhen("hourly :15")).toEqual({ kind: "hourly", minute: 15 });
    expect(parseWhen("Daily 9:05")).toEqual({ kind: "daily", hour: 9, minute: 5 });
    expect(parseWhen("weekdays 09:00")).toEqual({ kind: "weekdays", hour: 9, minute: 0 });
    expect(parseWhen("weekly mon 18:30")).toEqual({ kind: "weekly", weekday: 1, hour: 18, minute: 30 });
    expect(parseWhen("weekly sunday 07:00")).toEqual({ kind: "weekly", weekday: 0, hour: 7, minute: 0 });
    expect(parseWhen({ cron: "0 9 * * 1-5" })).toEqual({ kind: "cron", expression: "0 9 * * 1-5" });
  });

  it("reads one run on a date (req 34); the date's range is checked with the timing", () => {
    expect(parseWhen("once 2026-10-22 09:00")).toEqual({ kind: "once", date: "2026-10-22", hour: 9, minute: 0 });
    expect(parseWhen("Once 2026-02-30 7:05")).toEqual({ kind: "once", date: "2026-02-30", hour: 7, minute: 5 });
  });

  it("reads back what `shipit schedule list` shows, so the agent can copy it", () => {
    const timings = [
      { kind: "hourly", minute: 5 },
      { kind: "daily", hour: 9, minute: 0 },
      { kind: "weekdays", hour: 18, minute: 30 },
      { kind: "weekly", weekday: 3, hour: 7, minute: 15 },
      { kind: "once", date: "2026-10-22", hour: 9, minute: 0 },
      { kind: "cron", expression: "0 9 * * 1-5" },
    ] as const;
    for (const timing of timings) {
      expect(parseScheduleProposal(`when: ${formatWhen(timing)}`).timing).toEqual(timing);
    }
  });

  it("refuses anything else with the forms it takes", () => {
    for (const value of [
      "every morning",
      "daily",
      "daily 9am",
      "weekly 09:00",
      "weekly someday 09:00",
      "once 09:00",
      "once 2026-10-22",
      "once 22.10.2026 09:00",
      "once tomorrow 09:00",
      9,
      { cron: 5 },
      { cron: "0 9 * * *", tz: "x" },
    ]) {
      expect(() => parseWhen(value)).toThrow(/when must be a preset/);
    }
  });
});

describe("parseScheduleProposal", () => {
  it("reads every field", () => {
    expect(parseScheduleProposal([
      "name: Nightly",
      "when: daily 02:00",
      "timeZone: Europe/Berlin",
      "target: { sandbox: { docker: true, git: false } }",
      "params: { model: null, permissionMode: plan }",
      "prompt: Tidy up.",
      "enabled: false",
    ].join("\n"))).toEqual({
      name: "Nightly",
      timing: { kind: "daily", hour: 2, minute: 0 },
      timeZone: "Europe/Berlin",
      target: { kind: "sandbox", capabilities: { docker: true, git: false } },
      params: { model: null, permissionMode: "plan" },
      prompt: "Tidy up.",
      enabled: false,
    });
  });

  it("reads the target's three forms", () => {
    expect(parseScheduleProposal("target: { repo: https://github.com/o/r }").target)
      .toEqual({ kind: "repo", repoUrl: "https://github.com/o/r" });
    expect(parseScheduleProposal("target: sandbox").target).toEqual({ kind: "sandbox", capabilities: {} });
    expect(parseScheduleProposal("target:\n  sandbox:\n").target).toEqual({ kind: "sandbox", capabilities: {} });
  });

  it("refuses what is not a proposal, naming the problem", () => {
    expect(() => parseScheduleProposal("- a list")).toThrow(/must be a YAML mapping/);
    expect(() => parseScheduleProposal("name: a\nname: b")).toThrow(/not valid YAML/);
    expect(() => parseScheduleProposal("target: { sandbox: { root: true } }")).toThrow('Unknown sandbox grant "root"');
    expect(() => parseScheduleProposal("target: { sandbox: { docker: yes please } }")).toThrow(/must be true or false/);
    expect(() => parseScheduleProposal("target: { repo: a, sandbox: {} }")).toThrow(/target must be/);
    expect(() => parseScheduleProposal("params: [model]")).toThrow(/params must be a mapping/);
    expect(() => parseScheduleProposal("enabled: sometimes")).toThrow("enabled must be true or false.");
    expect(() => parseScheduleProposal(`prompt: ${"x".repeat(100_001)}`)).toThrow(/longer than 100,000 characters/);
  });
});
