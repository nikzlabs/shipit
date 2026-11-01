import { describe, it, expect } from "vitest";
import { createRedactedTail, REDACTED_TAIL_NOT_SHOWN, STDERR_TEXT_REMOVED } from "./redacted-tail.js";

// Credential shapes that are put together here, so that no secret scan reads one in this file.
const FAKE_KEY = ["sk", "proj", "k".repeat(28)].join("-");
const KEY_BODY = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj"];
const PEM_LINES = [
  ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
  ...KEY_BODY,
  ["-----END", "PRIVATE KEY-----"].join(" "),
];

function tailOf(pieces: string[], maxChars = 300): string {
  const tail = createRedactedTail();
  for (const piece of pieces) tail.add(piece);
  return tail.read(maxChars);
}

describe("createRedactedTail", () => {
  it("puts the pieces on one line", () => {
    expect(tailOf(["error: bad argument\n", "", "  Usage: codex [OPTIONS]"])).toBe(
      "error: bad argument Usage: codex [OPTIONS]",
    );
  });

  it("keeps the end and marks the cut", () => {
    const tail = tailOf([...Array.from({ length: 200 }, (_, i) => `retry ${i}`), "fatal: the last line"], 40);
    expect(tail).toHaveLength(41);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("fatal: the last line")).toBe(true);
  });

  it("redacts a credential, and keeps the text around it", () => {
    expect(tailOf([`401 for key ${FAKE_KEY} at https://api.example.test/v1`])).toBe(
      "401 for key [REDACTED] at https://api.example.test/v1",
    );
  });

  it("redacts a value whose name is on the line before it", () => {
    const opaque = "q7".repeat(9);
    expect(tailOf(["Authorization: Bearer", `${opaque} was refused`])).toBe(
      "Authorization: Bearer [REDACTED] was refused",
    );
  });

  it("redacts a private key block that came as lines", () => {
    const tail = tailOf(["loading the key", ...PEM_LINES, "fatal: the key was refused"]);
    expect(tail).toBe("loading the key [REDACTED] fatal: the key was refused");
  });

  it("redacts before it removes white space and cuts the length", () => {
    // With the white space gone first, the key is in the last characters and the cut goes through it.
    const tail = tailOf([`${FAKE_KEY}${" ".repeat(7_970)}fatal`], 20);
    expect(tail).toBe("[REDACTED] fatal");
  });

  // A cut changes which quotes are a pair: with the start gone, the second value is not redacted.
  it("shows nothing of a text that is longer than the budget", () => {
    const opaque = "s".repeat(40);
    const tail = tailOf([
      'API_KEY="x TOKEN=" ',
      "x".repeat(260_000),
      `API_KEY=" ${opaque}" fatal`,
    ]);
    expect(tail).toBe(REDACTED_TAIL_NOT_SHOWN);
  });

  it("shows nothing when one piece is longer than the budget", () => {
    expect(tailOf(["x".repeat(256_001), "fatal"])).toBe(REDACTED_TAIL_NOT_SHOWN);
  });

  it("takes a text that is as long as the budget", () => {
    expect(tailOf(["x".repeat(256_000)], 5)).toBe("…xxxxx");
    expect(tailOf(["x".repeat(255_999), ""], 5)).toBe("…xxxxx");
    expect(tailOf(["x".repeat(255_999), "y"])).toBe(REDACTED_TAIL_NOT_SHOWN);
  });

  // The emitter removed the line with the name and the first quote of the value.
  it("shows nothing of a text from which the emitter removed a line", () => {
    const opaque = "q7".repeat(20);
    expect(tailOf([STDERR_TEXT_REMOVED, `${opaque}" fatal`])).toBe(REDACTED_TAIL_NOT_SHOWN);
    expect(tailOf(["first", STDERR_TEXT_REMOVED, "fatal"])).toBe(REDACTED_TAIL_NOT_SHOWN);
  });

  it("shows the end of a long text that is in the budget", () => {
    const tail = tailOf([...Array.from({ length: 5_000 }, (_, i) => `retry ${i} of the upstream call`), "fatal: gave up"]);
    expect(tail.endsWith("retry 4999 of the upstream call fatal: gave up")).toBe(true);
  });
});
