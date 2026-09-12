import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usePrStore } from "../stores/pr-store.js";
import { saveMergeContinueOptOut } from "./local-storage.js";
import {
  mergeContinueFrameFields,
  syncMergeContinueOptOutAcrossTabs,
} from "./merge-continue-intent.js";

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

  it("has one authority — the store — and no second opinion to disagree with it", () => {
    // The composer used to pass its own `true` here. With the control shown and
    // ticked that says exactly what an omitted field says, so it was a second
    // reader of shared state and nothing more.
    expect(mergeContinueFrameFields.length).toBe(1);
  });
});

describe("cross-tab sync", () => {
  /**
   * The composer memoises what it read while a send reads afresh, so without
   * this another tab could DISPLAY an unticked box and send nothing, or display
   * a ticked one and send `false`. A control that disagrees with what it sends
   * is the defect class this whole feature keeps hitting.
   */
  it("pulls another tab's write into the store, so display and wire agree", () => {
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    const stop = syncMergeContinueOptOutAcrossTabs();
    // The other tab sent, which cleared the shared key.
    saveMergeContinueOptOut("s1", {});
    window.dispatchEvent(new StorageEvent("storage", {
      key: "shipit-merge-continue-optout:s1",
    }));
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toEqual({});
    expect(mergeContinueFrameFields("s1")).toEqual({});
    stop();
  });

  it("ignores storage keys that are not ours", () => {
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    const stop = syncMergeContinueOptOutAcrossTabs();
    window.dispatchEvent(new StorageEvent("storage", { key: "shipit-draft-message:s1" }));
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({ compact: true });
    stop();
  });

  it("stops listening when disposed", () => {
    usePrStore.getState().setMergeContinueOptOut("s1", "compact", true);
    syncMergeContinueOptOutAcrossTabs()();
    saveMergeContinueOptOut("s1", {});
    window.dispatchEvent(new StorageEvent("storage", {
      key: "shipit-merge-continue-optout:s1",
    }));
    expect(usePrStore.getState().mergeContinueOptOutBySession.s1).toMatchObject({ compact: true });
  });
});

/**
 * The drift guard.
 *
 * The first version of this scanned for `type: "send_message"` and accepted a
 * nearby builder call or an exemption comment. A review took it apart: split
 * literals, `type: someConstant` and different quoting all escaped it, and its
 * backward window let one frame's exemption silently cover the frame written
 * below it. A guard that can be walked past by accident is worse than none,
 * because it is cited as proof.
 *
 * So the rule is now structural rather than textual: the frame literal may
 * exist in exactly ONE non-test file, `send-user-turn.ts`, which owns the frame,
 * the intent and its consumption together. A producer that starts no turn calls
 * `sendGoalControlFrame`, whose signature takes a goal command and cannot send
 * an ordinary message — so the single exemption is enforced by a type, not by a
 * comment anyone can copy. It matches construction (`type:` + the discriminant)
 * and not comparisons. A frame assembled through a variable still escapes it;
 * that is a deliberate diff, not the accident this guards.
 */
const FRAME_OWNER = "utils/send-user-turn.ts";

describe("only one file builds a `send_message` frame", () => {
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

  /** Strip comments, so prose describing the frame is not mistaken for one. */
  const code = (file: string) =>
    fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("finds the owner, so a rename cannot silently empty this guard", () => {
    const owner = sources.find((f) => path.relative(clientDir, f) === FRAME_OWNER);
    expect(owner, `${FRAME_OWNER} not found — update FRAME_OWNER`).toBeDefined();
    expect(code(owner!)).toContain("send_message");
  });

  it("has no other file building one", () => {
    // CONSTRUCTION only — `type:` followed by the discriminant. A comparison
    // (`msg.type === "send_message"`) reads a frame rather than building one and
    // is none of this guard's business; flagging it would make the guard a
    // nuisance, and a nuisance guard gets deleted or worked around.
    const builders = sources
      .filter((f) => /type\s*:\s*["'`]send_message["'`]/.test(code(f)))
      .map((f) => path.relative(clientDir, f))
      .filter((rel) => rel !== FRAME_OWNER);
    expect(
      builders,
      `A \`send_message\` frame may only be built in ${FRAME_OWNER}, which applies the `
      + "post-merge per-send intent and spends it on delivery. Call `sendUserTurn` (a turn) "
      + `or \`sendControlFrame\` (starts no turn) instead. Offending files: ${builders.join(", ")}`,
    ).toEqual([]);
  });
});
