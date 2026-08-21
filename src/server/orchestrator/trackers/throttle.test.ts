import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRetryAfterSeconds, secondsUntilEpoch, waitPhrase } from "./throttle.js";

afterEach(() => {
  vi.useRealTimers();
});

function withRetryAfter(value: string): Response {
  return new Response("", { status: 403, headers: { "Retry-After": value } });
}

describe("parseRetryAfterSeconds", () => {
  it("reads the delta-seconds form GitHub sends", () => {
    expect(parseRetryAfterSeconds(withRetryAfter("60"))).toBe(60);
    expect(parseRetryAfterSeconds(withRetryAfter(" 5 "))).toBe(5);
  });

  it("reads the HTTP-date form, floored at zero for a past date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    expect(parseRetryAfterSeconds(withRetryAfter("Fri, 07 Aug 2026 12:02:00 GMT"))).toBe(120);
    expect(parseRetryAfterSeconds(withRetryAfter("Fri, 07 Aug 2026 11:00:00 GMT"))).toBe(0);
  });

  it("is null when absent or unparseable", () => {
    expect(parseRetryAfterSeconds(new Response("", { status: 403 }))).toBeNull();
    expect(parseRetryAfterSeconds(withRetryAfter("soon"))).toBeNull();
  });
});

describe("secondsUntilEpoch", () => {
  it("counts down to the deadline and never goes negative", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    expect(secondsUntilEpoch(now + 300)).toBe(300);
    expect(secondsUntilEpoch(now - 300)).toBe(0);
    expect(secondsUntilEpoch(null)).toBeNull();
  });
});

describe("waitPhrase", () => {
  it("renders seconds below 90 and rounds up to minutes above", () => {
    expect(waitPhrase(45)).toBe("45 seconds");
    expect(waitPhrase(89)).toBe("89 seconds");
    expect(waitPhrase(90)).toBe("2 minutes");
    expect(waitPhrase(901)).toBe("16 minutes");
  });

  it("stays vague when the backend did not say", () => {
    expect(waitPhrase(null)).toBe("a few minutes");
    expect(waitPhrase(undefined)).toBe("a few minutes");
    expect(waitPhrase(0)).toBe("a few minutes");
  });
});
