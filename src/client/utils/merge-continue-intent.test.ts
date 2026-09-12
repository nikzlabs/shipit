import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usePrStore } from "../stores/pr-store.js";
import { saveMergeContinueOptOut } from "./local-storage.js";
import { mergeContinueFrameFields } from "./merge-continue-intent.js";

beforeEach(() => {
  usePrStore.setState({ mergeContinueOptOutBySession: {} });
  localStorage.clear();
});

describe("mergeContinueFrameFields (docs/218 + docs/295)", () => {
  it("carries nothing when the user has unticked nothing", () => {
    // Absent and `true` both mean "do it", and the server's own eligibility
    // gates still apply — so a ticked control needs no field on the wire.
    expect(mergeContinueFrameFields("s1")).toEqual({});
  });

  it("carries `false` for a control the user unticked", () => {
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    expect(mergeContinueFrameFields("s1")).toEqual({ compactContext: false });
  });

  it("reads the durable mirror when the store has nothing (after a reload)", () => {
    saveMergeContinueOptOut("s1", { reset: true, compact: true });
    expect(mergeContinueFrameFields("s1")).toEqual({
      resetMergedBranch: false,
      compactContext: false,
    });
  });

  it("keeps sessions apart", () => {
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    expect(mergeContinueFrameFields("s2")).toEqual({});
  });

  it("carries nothing with no session", () => {
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    expect(mergeContinueFrameFields(undefined)).toEqual({});
  });

  it("lets the composer state its own answer, including an explicit `true`", () => {
    // Only the composer knows whether it actually SHOWED the control, so it
    // passes its own values; every other producer passes nothing.
    expect(mergeContinueFrameFields("s1", { compactContext: true, resetMergedBranch: true }))
      .toEqual({ compactContext: true, resetMergedBranch: true });
  });

  it("prefers an explicit `false` over a store that has nothing", () => {
    expect(mergeContinueFrameFields("s1", { compactContext: false }))
      .toEqual({ compactContext: false });
  });
});

/**
 * The drift guard, and the reason this file scans source instead of testing
 * five call sites.
 *
 * The flags were spread by hand at each producer of a `send_message` frame, and
 * exactly one producer did it. The other five — the action-card button, both
 * release-card buttons, the review-comments submit and "ask the agent to review
 * this file" — sent neither flag, so a user who unticked "Compact the context"
 * and then pressed a button on a card was compacted anyway while their untick
 * sat on screen untouched. docs/293 had already closed the same omission for
 * the `/review` branch *inside* `runSend`; closing it one site at a time is
 * what let the rest drift.
 *
 * So the rule is structural: a new producer either carries the intent or says,
 * at the frame, why it does not. A test over the five known call sites would
 * have passed on the day the sixth was written.
 */
const NOT_APPLICABLE = "merge-continue-intent: not-applicable";

describe("every `send_message` producer carries the per-send intent", () => {
  const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full);
    }
  };
  walk(clientDir);

  it("finds the producers it is meant to be guarding", () => {
    const producing = sources.filter((f) => fs.readFileSync(f, "utf8").includes('type: "send_message"'));
    // Fewer than this means the scan broke, not that the code got tidier.
    expect(producing.length).toBeGreaterThanOrEqual(2);
  });

  it("has every frame either build the fields or declare itself exempt", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes('type: "send_message"')) return;
        // Prose that merely mentions the frame is not a producer of one.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // The frame's own object literal, plus a SHORT lead-in. Deliberately
        // tight above: a generous backward window lets an exemption written for
        // one frame silently cover an unrelated frame added below it, which is
        // the same "nobody re-derived the reason" failure this guard exists for.
        // So the marker goes on the line next to the frame; its justification
        // can be as long as it needs to be above that.
        const frame = lines.slice(Math.max(0, i - 3), i + 14).join("\n");
        if (frame.includes("mergeContinueFrameFields(") || frame.includes(NOT_APPLICABLE)) return;
        offenders.push(`${path.relative(clientDir, file)}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "A `send_message` frame must spread `mergeContinueFrameFields(sessionId)` so a "
      + "post-merge untick reaches the server, or carry the comment "
      + `\`${NOT_APPLICABLE}\` saying why it cannot. Offending frames: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
