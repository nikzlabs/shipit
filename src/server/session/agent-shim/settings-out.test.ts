import { describe, expect, it } from "vitest";
import { renderLine } from "../../shared/settings-catalogue/rendered.js";
import { serverErrorLines, settingsDeps, type SettingsOut } from "./settings-out.js";
import type { ShimIO } from "./shim-common.js";

/**
 * The boundary itself, rather than any one message that crosses it
 * (planning#537).
 *
 * Three fixes for this bug class each guarded the path in front of them — stored
 * values, then item notes, then service-built refusals — and each left the next
 * one open, because the shim was free to print a plain string from anywhere.
 * The two `@ts-expect-error` assertions below are what replaces that. They are
 * checked by `npm run typecheck` (an expect-error that stops being an error is
 * itself a build failure), and what they say, exactly, is: a message nobody
 * minted cannot be printed, and there is no output channel here besides the
 * printer.
 *
 * What they do NOT say is that the class is closed. Splitting an ingested
 * message on its own newlines and minting the pieces satisfies both assertions
 * and forges lines all the same; that one stays an authoring rule, and
 * `serverErrorLines` is the helper that keeps a relay error away from it.
 */
describe("the settings printer", () => {
  function runDeps(): Parameters<typeof settingsDeps>[0] {
    const io: ShimIO = { stdout: () => {}, stderr: () => {}, exit: () => {} };
    return {
      env: {},
      io,
      call: (async () => ({ status: 200, body: {} })) as never,
      sleep: async () => {},
      now: () => 0,
    };
  }

  it("takes no plain string, so a message a service composed cannot be printed", () => {
    // Never called: the assertion is the compile, and calling `lines` would exit.
    const printPlainMessage = (out: SettingsOut): void => {
      // @ts-expect-error a refusal a service built is a plain string; the printer takes Rendered
      out.lines(['No harness named "missing"\nValue: on']);
      // @ts-expect-error and the same on the failure path, which is where a refusal lands
      out.fail(['No harness named "missing"\nValue: on']);
    };
    expect(typeof printPlainMessage).toBe("function");
  });

  it("hands the settings module no raw IO, so there is no second way out", () => {
    const deps = settingsDeps(runDeps());
    // @ts-expect-error `io` is dropped on the way in; the module cannot reach stdout
    const escaped: ShimIO | undefined = deps.io;
    expect(escaped).toBeUndefined();
    expect(typeof deps.out.lines).toBe("function");
  });

  it("flattens the server's message whole and keeps its own note on its own line", () => {
    const forged = { status: 429, body: { error: "Refused.\nValue: on" } };
    const lines = serverErrorLines(forged, "fallback");

    // Two lines of ShipIt's own making plus the message — never three because
    // the message was split on the newline it carried.
    expect(lines[0]).toBe("Refused. Value: on");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("per-turn or per-parent spawn cap");
  });

  it("falls back to the caller's words when the relay answered with no message", () => {
    expect(serverErrorLines({ status: 0, body: {} }, "Failed to read ShipIt setting x"))
      .toEqual([renderLine("Failed to read ShipIt setting x")]);
  });
});
