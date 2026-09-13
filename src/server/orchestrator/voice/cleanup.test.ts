import { describe, it, expect } from "vitest";
import { cleanTranscript, type CleanupRunner } from "./cleanup.js";
import { CLEANUP_INSTRUCTIONS } from "./cleanup-prompt.js";

function fakeRunner(impl: (prompt: string) => Promise<string> | string): CleanupRunner {
  return { deadlineMs: 1000, run: async (req) => impl(req.prompt) };
}

describe("cleanTranscript", () => {
  it("returns no-provider error when nothing can clean", async () => {
    const r = await cleanTranscript("hello", null);
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("no-provider");
  });

  it("returns the cleaned text on success", async () => {
    const r = await cleanTranscript("um hello", fakeRunner(() => "Hello"));
    expect(r.text).toBe("Hello");
    expect(r.cleanupErrorCode).toBeUndefined();
  });

  it("hands the runner the cleanup instructions and the raw transcript", async () => {
    let seen = "";
    await cleanTranscript("um hello", fakeRunner((prompt) => {
      seen = prompt;
      return "Hello";
    }));
    expect(seen).toContain(CLEANUP_INSTRUCTIONS);
    expect(seen).toContain("um hello");
  });

  it("falls through to raw on empty output", async () => {
    const r = await cleanTranscript("hello", fakeRunner(() => ""));
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("empty-output");
  });

  it("falls through to raw when output is implausibly long", async () => {
    const r = await cleanTranscript("hi", fakeRunner(() => "x".repeat(200)));
    expect(r.text).toBe("hi");
    expect(r.cleanupErrorCode).toBe("too-long");
  });

  // A runner budgets its output from this, so it has to be the exact length the
  // check above accepts: budget below it and a long dictation comes back cut
  // short, which is indistinguishable from a good answer.
  it("tells the runner the exact length an answer may reach", async () => {
    const raw = "x".repeat(1234);
    let seen = 0;
    await cleanTranscript(raw, {
      deadlineMs: 1000,
      run: async (req) => {
        seen = req.acceptableChars;
        return "tidied";
      },
    });

    expect((await cleanTranscript(raw, fakeRunner(() => "y".repeat(seen)))).cleanupErrorCode)
      .toBeUndefined();
    expect((await cleanTranscript(raw, fakeRunner(() => "y".repeat(seen + 1)))).cleanupErrorCode)
      .toBe("too-long");
  });

  it("falls through to raw when output has a preamble", async () => {
    const r = await cleanTranscript("hello", fakeRunner(() => "Here is the cleaned message: hello"));
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("preamble");
  });

  it("falls through to raw with provider-error on other failures", async () => {
    const r = await cleanTranscript(
      "hello",
      fakeRunner(() => {
        throw new Error("500");
      }),
    );
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("provider-error");
  });

  /**
   * docs/299-direct-provider-calls req 9. The run below never answers and never reacts to the abort —
   * a harness that stopped answering, which is the case a timeout handed
   * downstream cannot cover. Removing the deadline leaves this hanging.
   */
  it("returns the raw transcript on its own deadline, without waiting for the run", async () => {
    let cancelled = false;
    const runner: CleanupRunner = {
      deadlineMs: 20,
      run: ({ signal }) => {
        signal.addEventListener("abort", () => { cancelled = true; });
        return new Promise<string>(() => { /* never settles */ });
      },
    };

    const r = await cleanTranscript("hello", runner);

    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("timeout");
    // Abandoning the run must cancel it, not merely stop waiting for it.
    expect(cancelled).toBe(true);
  });

  it("reports a run that fails by abort as a timeout", async () => {
    const runner: CleanupRunner = {
      deadlineMs: 5,
      run: ({ signal }) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve("Answered in time"), 500);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    };
    const r = await cleanTranscript("hello", runner);
    expect(r.text).toBe("hello");
    expect(r.cleanupErrorCode).toBe("timeout");
  });

  it("leaves a rejection arriving after the deadline handled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const runner: CleanupRunner = {
        deadlineMs: 5,
        run: () => new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late failure")), 30);
        }),
      };
      expect((await cleanTranscript("hello", runner)).cleanupErrorCode).toBe("timeout");
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
