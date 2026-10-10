import { describe, it, expect } from "vitest";
import { parseGitHubError } from "./github-api.js";

function answer(body: unknown, status = 422, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("parseGitHubError", () => {
  it("adds the reason of a validation error to the top-level message", async () => {
    const cases: [unknown, string][] = [
      [
        [{ resource: "Issue", field: "body", code: "custom", message: "body is too long (maximum is 65536 characters)" }],
        "Validation Failed: body is too long (maximum is 65536 characters)",
      ],
      // As the search API answers a request with no query.
      [[{ resource: "Search", field: "q", code: "missing" }], "Validation Failed: q: missing"],
      [[{ resource: "Issue", code: "invalid" }], "Validation Failed: invalid"],
      [["Sorry, you can not do that"], "Validation Failed: Sorry, you can not do that"],
      [
        [{ field: "title", code: "missing_field" }, { message: "No commits between main and topic" }],
        "Validation Failed: title: missing_field; No commits between main and topic",
      ],
    ];
    for (const [errors, expected] of cases) {
      expect(await parseGitHubError(answer({ message: "Validation Failed", errors })), expected).toBe(expected);
    }
  });

  it("returns the top-level message alone when the answer has no usable errors", async () => {
    for (const errors of [
      undefined,
      null,
      [],
      "body is too long",
      { message: "not a list" },
      7,
      [null, 42, {}],
      [{ message: 5 }],
      [{ message: "  " }],
      [{ field: 5, code: ["invalid"] }],
    ]) {
      const res = answer({ message: "Validation Failed", ...(errors === undefined ? {} : { errors }) });
      expect(await parseGitHubError(res), JSON.stringify(errors)).toBe("Validation Failed");
    }
  });

  it("uses the field and the code of an entry whose message is not text", async () => {
    const res = answer({ message: "Validation Failed", errors: [{ message: 5, field: "title", code: "invalid" }] });
    expect(await parseGitHubError(res)).toBe("Validation Failed: title: invalid");
  });

  it("does not throw on a top-level message that is not text", async () => {
    const res = answer({ message: { toString: null }, errors: ["invalid"] });
    expect(await parseGitHubError(res)).toBe("GitHub API returned 422: invalid");
    expect(await parseGitHubError(answer({ message: 7 }, 500, { "x-github-request-id": "C0DE:1" }))).toBe(
      "GitHub API returned 500 (GitHub request id C0DE:1)",
    );
  });

  it("gives the first three entries only", async () => {
    const errors = ["one", "two", "three", "four", "five"].map((message) => ({ message }));
    expect(await parseGitHubError(answer({ message: "Validation Failed", errors }))).toBe(
      "Validation Failed: one; two; three",
    );
    // An entry that gives no text is one of the three.
    expect(await parseGitHubError(answer({ message: "Validation Failed", errors: [null, ...errors] }))).toBe(
      "Validation Failed: one; two",
    );
  });

  it("puts the reasons on one line and limits their length", async () => {
    const lines = await parseGitHubError(
      answer({ message: "Validation Failed", errors: [{ message: "first line\r\n\r\n[ShipIt] second\tline" }] }),
    );
    expect(lines).toBe("Validation Failed: first line [ShipIt] second line");

    const controls = await parseGitHubError(
      answer({ message: "Validation Failed", errors: [{ message: "red\u001b[31m text\u0000 end\u007f" }] }),
    );
    expect(controls).toBe("Validation Failed: red [31m text end");

    const long = await parseGitHubError(
      answer({ message: "Validation Failed", errors: [{ message: "x".repeat(1000) }, { message: "y".repeat(1000) }] }),
    );
    expect(long).toBe(`Validation Failed: ${"x".repeat(299)}…`);
  });

  it("names the status when the answer has reasons and no top-level message", async () => {
    expect(await parseGitHubError(answer({ errors: [{ message: "Something went wrong" }] }, 502))).toBe(
      "GitHub API returned 502: Something went wrong",
    );
  });

  it("keeps the request id of a server error after the reasons", async () => {
    const res = answer({ message: "Server Error", errors: [{ message: "timeout" }] }, 500, {
      "x-github-request-id": "C0DE:1234:ABCD",
    });
    expect(await parseGitHubError(res)).toBe("Server Error: timeout (GitHub request id C0DE:1234:ABCD)");
  });

  it("names the status when the body is not JSON", async () => {
    expect(await parseGitHubError(answer("<html>Bad Gateway</html>", 502))).toBe("GitHub API returned 502");
  });
});
