import { describe, it, expect } from "vitest";
import { etagFor, matchesIfNoneMatch } from "./http-etag.js";

describe("etagFor", () => {
  it("is stable for the same bytes and different for different ones", () => {
    expect(etagFor("hello")).toBe(etagFor("hello"));
    expect(etagFor("hello")).not.toBe(etagFor("hello "));
  });

  it("is a quoted strong tag", () => {
    expect(etagFor("x")).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });
});

describe("matchesIfNoneMatch", () => {
  const tag = etagFor("body");

  it("matches the exact strong tag", () => {
    expect(matchesIfNoneMatch(tag, tag)).toBe(true);
  });

  it("matches the weak form a CDN produces", () => {
    expect(matchesIfNoneMatch(`W/${tag}`, tag)).toBe(true);
  });

  it("matches inside a comma-separated list, weak or strong", () => {
    expect(matchesIfNoneMatch(`"other", W/${tag}`, tag)).toBe(true);
    expect(matchesIfNoneMatch(`${tag}, "other"`, tag)).toBe(true);
  });

  it("matches a header delivered as an array", () => {
    expect(matchesIfNoneMatch([`"other"`, `W/${tag}`], tag)).toBe(true);
  });

  it("matches the wildcard", () => {
    expect(matchesIfNoneMatch("*", tag)).toBe(true);
  });

  it("does not match a different tag, absent header, or empty string", () => {
    expect(matchesIfNoneMatch(etagFor("something else"), tag)).toBe(false);
    expect(matchesIfNoneMatch(undefined, tag)).toBe(false);
    expect(matchesIfNoneMatch("", tag)).toBe(false);
  });

  it("does not treat a tag that merely contains another as a match", () => {
    expect(matchesIfNoneMatch('"abcdef"', '"abc"')).toBe(false);
  });
});
