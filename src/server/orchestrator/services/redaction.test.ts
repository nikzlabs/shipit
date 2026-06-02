import { describe, it, expect } from "vitest";
import { redactStage1, redact, REDACTION_PLACEHOLDER } from "./redaction.js";

describe("redactStage1 (deterministic floor)", () => {
  it("scrubs an inline GitHub PAT", () => {
    const { text } = redactStage1("here is my token ghp_ABCDEFGHIJKLMNOP1234567890abcd and done");
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a fine-grained PAT", () => {
    const { text } = redactStage1("github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789");
    expect(text).not.toContain("github_pat_11ABCDEFG");
    expect(text).toBe(REDACTION_PLACEHOLDER);
  });

  it("scrubs an OpenAI-style key and an Anthropic key", () => {
    const open = redactStage1("key sk-abcdefghijklmnopqrstuvwx here");
    expect(open.text).not.toContain("sk-abcdefghijklmnop");
    const ant = redactStage1("key sk-ant-abcdefghijklmnop here");
    expect(ant.text).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("scrubs an email address", () => {
    const { text } = redactStage1("contact me at jane.doe@example.com please");
    expect(text).not.toContain("jane.doe@example.com");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a bearer token", () => {
    const { text } = redactStage1("Authorization: Bearer abcdef1234567890XYZ");
    expect(text).not.toContain("abcdef1234567890XYZ");
  });

  it("scrubs a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4";
    const { text } = redactStage1(`token=${jwt}`);
    expect(text).not.toContain(jwt);
  });

  it("scrubs a credentialed git remote URL", () => {
    const { text } = redactStage1(
      "remote https://x-access-token:ghp_secrettoken12345678@github.com/acme/secret-project.git",
    );
    expect(text).not.toContain("github.com/acme/secret-project");
    expect(text).not.toContain("ghp_secrettoken");
  });

  it("scrubs an absolute workspace path that leaks a project name", () => {
    const { text } = redactStage1("error in /workspace/my-secret-app/src/index.ts at line 5");
    expect(text).not.toContain("/workspace/my-secret-app/src/index.ts");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a home-directory path", () => {
    const { text } = redactStage1("config at /home/jane/.ssh/id_rsa");
    expect(text).not.toContain("/home/jane/.ssh/id_rsa");
  });

  it("leaves benign prose untouched", () => {
    const input = "The preview pane wouldn't reload after I edited a file.";
    const { text, redactedCount } = redactStage1(input);
    expect(text).toBe(input);
    expect(redactedCount).toBe(0);
  });
});

describe("redact (two-stage)", () => {
  it("runs Stage 1 only when no model runner is provided", async () => {
    const result = await redact("token ghp_ABCDEFGHIJKLMNOP1234567890abcd");
    expect(result.stage2Ran).toBe(false);
    expect(result.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");
  });

  it("applies Stage-2 spans returned by the model (deletions only)", async () => {
    const run = async () => JSON.stringify({ spans: ["Acme Corp", "Jane Smith"] });
    const result = await redact("Reported by Jane Smith at Acme Corp during the demo.", { run });
    expect(result.stage2Ran).toBe(true);
    expect(result.body).not.toContain("Jane Smith");
    expect(result.body).not.toContain("Acme Corp");
    expect(result.body).toContain(REDACTION_PLACEHOLDER);
  });

  it("ignores model 'spans' that are not verbatim substrings (no injection)", async () => {
    // The model returns a span that doesn't appear in the text — an addition,
    // not a deletion. It must be dropped, leaving the text otherwise intact.
    const run = async () => JSON.stringify({ spans: ["TOTALLY NEW INJECTED TEXT"] });
    const input = "The build crashed on startup.";
    const result = await redact(input, { run });
    expect(result.stage2Ran).toBe(true);
    expect(result.body).toBe(input);
    expect(result.body).not.toContain("INJECTED");
  });

  it("degrades to the Stage-1 floor + flag when the model call fails", async () => {
    const run = async () => {
      throw new Error("CLI timed out");
    };
    const result = await redact("token ghp_ABCDEFGHIJKLMNOP1234567890abcd and name Jane Smith", { run });
    // Stage-2 didn't run → flagged, but Stage 1 still scrubbed the token.
    expect(result.stage2Ran).toBe(false);
    expect(result.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    // The unstructured name survives (Stage 1 can't see it) — that's exactly
    // why the card flags the missed Stage-2 pass for human review.
    expect(result.body).toContain("Jane Smith");
  });

  it("degrades when the model output is unparseable", async () => {
    const run = async () => "I'm sorry, I cannot do that.";
    const result = await redact("hello world", { run });
    expect(result.stage2Ran).toBe(false);
    expect(result.body).toBe("hello world");
  });
});
