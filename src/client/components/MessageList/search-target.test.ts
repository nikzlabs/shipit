import { describe, it, expect, afterEach } from "vitest";
import { describeMatch, locateMatch } from "./search-target.js";
import type { ChatMessage } from "./types.js";

function transcript(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

/** The match at `start` in `text`, as `useSearch` would report it. */
function described(text: string, start: number, length: number) {
  return describeMatch([{ role: "assistant", text }], { messageIndex: 0, start, length })!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("describeMatch", () => {
  const messages: ChatMessage[] = [{ role: "assistant", text: "Needle, needle, NEEDLE" }];

  it("names the occurrence the match is, case-insensitively", () => {
    expect(describeMatch(messages, { messageIndex: 0, start: 16, length: 6 }))
      .toMatchObject({ needle: "needle", ordinal: 2 });
  });

  it("counts overlapping occurrences, as the search does", () => {
    const aaa: ChatMessage[] = [{ role: "user", text: "aaa" }];
    expect(describeMatch(aaa, { messageIndex: 0, start: 1, length: 2 })?.ordinal).toBe(1);
  });

  it("has nothing to describe for a message that is not there", () => {
    expect(describeMatch(messages, { messageIndex: 4, start: 0, length: 6 })).toBeNull();
  });
});

describe("locateMatch", () => {
  it("finds an occurrence that the rendering splits across elements", () => {
    // A path in the source becomes a link in the row.
    const container = transcript('<div data-compact-index="2"><p>open <a>src/needle.ts</a> now</p></div>');
    const found = locateMatch(container, 2, described("open src/needle.ts now", 0, "open src".length));
    expect(found).toBeInstanceOf(Range);
    expect((found as Range).toString()).toBe("open src");
  });

  it("is not thrown off by an occurrence the source has and the row does not show", () => {
    const source = "[link](https://example.com/needle) first needle, second needle";
    const container = transcript('<div data-compact-index="0"><p><a>link</a> first needle, second needle</p></div>');
    const found = locateMatch(container, 0, described(source, source.indexOf("first needle") + 6, 6)) as Range;
    expect(found.startContainer.textContent).toBe(" first needle, second needle");
    expect(found.startOffset).toBe(" first ".length);
  });

  it("counts by occurrence, not by the words around it", () => {
    const source = "[link](https://example.com/second) needle second needle";
    const container = transcript('<div data-compact-index="0"><p><a>link</a> needle second needle</p></div>');
    const first = locateMatch(container, 0, described(source, source.indexOf("needle"), 6)) as Range;
    const second = locateMatch(container, 0, described(source, source.lastIndexOf("needle"), 6)) as Range;
    expect([first.startOffset, second.startOffset]).toEqual([1, " needle second ".length]);
  });

  it("does not point at a shown occurrence for one inside a link's URL", () => {
    const source = "[docs](https://example.com/needle)";
    expect(describeMatch([{ role: "assistant", text: source }], { messageIndex: 0, start: source.indexOf("needle"), length: 6 }))
      .toBeNull();
  });

  it("keeps its offsets on text whose lowercase is longer", () => {
    const container = transcript('<div data-compact-index="0"><p>needle İ</p></div>');
    const found = locateMatch(container, 0, described("needle İ", 0, 6)) as Range;
    expect(found.toString()).toBe("needle");
  });

  it("falls back to the row when the row does not show the text", () => {
    const container = transcript('<div data-compact-index="3"><p>a card</p></div>');
    expect(locateMatch(container, 3, described("needle", 0, 6))).toBe(container.firstElementChild);
  });

  it("returns nothing when the message has no row", () => {
    expect(locateMatch(transcript("<p>needle</p>"), 7, described("needle", 0, 6))).toBeNull();
  });
});
