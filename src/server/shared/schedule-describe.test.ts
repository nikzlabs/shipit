import { describe, expect, it } from "vitest";
import { describeGrants, describeTarget, describeTiming } from "./schedule-describe.js";

describe("describeTiming", () => {
  it("says each preset and a cron expression in words", () => {
    expect(describeTiming({ kind: "hourly", minute: 5 })).toBe("Every hour at :05");
    expect(describeTiming({ kind: "daily", hour: 9, minute: 0 })).toBe("Every day at 09:00");
    expect(describeTiming({ kind: "weekdays", hour: 18, minute: 30 })).toBe("Weekdays at 18:30");
    expect(describeTiming({ kind: "weekly", weekday: 0, hour: 7, minute: 15 })).toBe("Every Sunday at 07:15");
    expect(describeTiming({ kind: "cron", expression: " 0 9 * * 1-5 " })).toBe("Cron 0 9 * * 1-5");
  });
});

describe("describeTarget and describeGrants", () => {
  it("names a repository by its URL, and every sandbox grant in the dialog's words", () => {
    expect(describeTarget({ kind: "repo", repoUrl: "https://github.com/o/r" })).toBe("Repository https://github.com/o/r");
    expect(describeGrants({ git: true, dangerousGitHubOps: false, docker: false, network: true }))
      .toBe("GitHub access: on · Allow merging PRs: off · Docker access: off · Network access: on");
  });
});
