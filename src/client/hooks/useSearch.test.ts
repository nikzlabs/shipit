import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSearch } from "./useSearch.js";
import type { ChatMessage } from "../components/MessageList.js";

function makeMessages(...texts: string[]): ChatMessage[] {
  return texts.map((text) => ({ role: "user" as const, text }));
}

describe("useSearch", () => {
  describe("matching", () => {
    it("returns no matches for empty query", () => {
      const messages = makeMessages("hello world", "foo bar");
      const { result } = renderHook(() => useSearch(messages));

      expect(result.current.matches).toEqual([]);
    });

    it("returns no matches for whitespace-only query", () => {
      const messages = makeMessages("hello world");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("   "));
      expect(result.current.matches).toEqual([]);
    });

    it("finds a single match", () => {
      const messages = makeMessages("hello world");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("hello"));
      expect(result.current.matches).toHaveLength(1);
      expect(result.current.matches[0]).toEqual({
        messageIndex: 0,
        start: 0,
        length: 5,
      });
    });

    it("is case-insensitive", () => {
      const messages = makeMessages("Hello World");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("hello"));
      expect(result.current.matches).toHaveLength(1);
    });

    it("finds multiple matches in the same message", () => {
      const messages = makeMessages("foo bar foo baz foo");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("foo"));
      expect(result.current.matches).toHaveLength(3);
      expect(result.current.matches[0].start).toBe(0);
      expect(result.current.matches[1].start).toBe(8);
      expect(result.current.matches[2].start).toBe(16);
    });

    it("finds matches across multiple messages", () => {
      const messages = makeMessages("hello there", "no match", "hello again");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("hello"));
      expect(result.current.matches).toHaveLength(2);
      expect(result.current.matches[0].messageIndex).toBe(0);
      expect(result.current.matches[1].messageIndex).toBe(2);
    });

    it("handles overlapping potential matches correctly (non-overlapping search)", () => {
      const messages = makeMessages("aaa");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("aa"));
      // "aaa" has "aa" at pos 0 and pos 1
      expect(result.current.matches).toHaveLength(2);
    });

    it("skips messages with empty text", () => {
      const messages: ChatMessage[] = [
        { role: "user", text: "" },
        { role: "assistant", text: "hello" },
      ];
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("hello"));
      expect(result.current.matches).toHaveLength(1);
      expect(result.current.matches[0].messageIndex).toBe(1);
    });
  });

  describe("navigation", () => {
    it("starts at currentMatchIndex 0", () => {
      const messages = makeMessages("a a a");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("a"));
      expect(result.current.currentMatchIndex).toBe(0);
    });

    it("goToNext cycles through matches", () => {
      const messages = makeMessages("a b a b a");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("a"));
      expect(result.current.currentMatchIndex).toBe(0);

      act(() => result.current.goToNext());
      expect(result.current.currentMatchIndex).toBe(1);

      act(() => result.current.goToNext());
      expect(result.current.currentMatchIndex).toBe(2);

      // Wraps around
      act(() => result.current.goToNext());
      expect(result.current.currentMatchIndex).toBe(0);
    });

    it("goToPrev cycles backward through matches", () => {
      const messages = makeMessages("a b a b a");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("a"));

      // From 0, going prev wraps to last match
      act(() => result.current.goToPrev());
      expect(result.current.currentMatchIndex).toBe(2);

      act(() => result.current.goToPrev());
      expect(result.current.currentMatchIndex).toBe(1);
    });

    it("resets currentMatchIndex when query changes", () => {
      const messages = makeMessages("hello world foo bar");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("o"));
      act(() => result.current.goToNext());
      expect(result.current.currentMatchIndex).toBe(1);

      // Changing query resets index
      act(() => result.current.setQuery("foo"));
      expect(result.current.currentMatchIndex).toBe(0);
    });

    it("goToNext is a no-op when no matches", () => {
      const messages = makeMessages("hello");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("xyz"));
      act(() => result.current.goToNext());
      expect(result.current.currentMatchIndex).toBe(0);
    });

    it("currentMatch returns the current match object", () => {
      const messages = makeMessages("hello");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("hello"));
      expect(result.current.currentMatch).toEqual({
        messageIndex: 0,
        start: 0,
        length: 5,
      });
    });

    it("currentMatch is undefined when no matches", () => {
      const messages = makeMessages("hello");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("xyz"));
      expect(result.current.currentMatch).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("resets query and match index", () => {
      const messages = makeMessages("hello world");
      const { result } = renderHook(() => useSearch(messages));

      act(() => result.current.setQuery("hello"));
      expect(result.current.matches).toHaveLength(1);

      act(() => result.current.clear());
      expect(result.current.query).toBe("");
      expect(result.current.matches).toEqual([]);
      expect(result.current.currentMatchIndex).toBe(0);
    });
  });
});
