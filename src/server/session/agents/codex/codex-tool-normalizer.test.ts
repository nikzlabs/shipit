import { describe, it, expect } from "vitest";
import {
  unwrapShellCommand,
  buildCodexPermissionInput,
  fileChangeKindLabel,
  normalizeFileChangeDiff,
  normalizeWebSearchItem,
  isAskUserQuestionTool,
} from "./codex-tool-normalizer.js";

describe("unwrapShellCommand", () => {
  it("strips the /bin/bash -lc wrapper (single and double quotes)", () => {
    expect(unwrapShellCommand("/bin/bash -lc 'ls -la'")).toBe("ls -la");
    expect(unwrapShellCommand(`/bin/bash -lc "sed -n '1,20p' docs/plan.md"`)).toBe("sed -n '1,20p' docs/plan.md");
    expect(unwrapShellCommand("bash -c 'echo hi'")).toBe("echo hi");
    expect(unwrapShellCommand("sh -c 'echo hi'")).toBe("echo hi");
  });

  it("preserves inner quotes that aren't the outer wrapper", () => {
    expect(unwrapShellCommand(`/bin/bash -lc 'rg -n "^status:" docs/a.md'`)).toBe('rg -n "^status:" docs/a.md');
  });

  it("leaves non-wrapped commands unchanged", () => {
    expect(unwrapShellCommand("ls -la")).toBe("ls -la");
    expect(unwrapShellCommand("npm run build")).toBe("npm run build");
    expect(unwrapShellCommand("")).toBe("");
  });
});

describe("buildCodexPermissionInput (docs/193)", () => {
  it("derives the first changed path for a fileChange approval (v2 + v1)", () => {
    expect(buildCodexPermissionInput("item/fileChange/requestApproval", { item: { changes: [{ path: ".npmrc" }] } }))
      .toEqual({ toolName: "apply_patch", input: { file_path: ".npmrc" } });
    expect(buildCodexPermissionInput("applyPatchApproval", { changes: [{ path: ".env" }] }))
      .toEqual({ toolName: "apply_patch", input: { file_path: ".env" } });
  });

  it("derives the unwrapped command for a commandExecution approval (string + argv)", () => {
    expect(buildCodexPermissionInput("item/commandExecution/requestApproval", { item: { command: "/bin/bash -lc 'npm i'", cwd: "/workspace" } }))
      .toEqual({ toolName: "shell", input: { command: "npm i", cwd: "/workspace" } });
    expect(buildCodexPermissionInput("execCommandApproval", { command: ["ls", "-la"] }))
      .toEqual({ toolName: "shell", input: { command: "ls -la" } });
  });
});

describe("fileChangeKindLabel", () => {
  it("returns a plain string kind unchanged", () => {
    expect(fileChangeKindLabel("add")).toBe("add");
    expect(fileChangeKindLabel("update")).toBe("update");
  });

  it("reads the `type` of an internally-tagged enum object (the [object Object] bug)", () => {
    expect(fileChangeKindLabel({ type: "update", move_path: null })).toBe("update");
    expect(fileChangeKindLabel({ type: "add" })).toBe("add");
  });

  it("falls back to the first key of an externally-tagged object, then to 'update'", () => {
    expect(fileChangeKindLabel({ delete: {} })).toBe("delete");
    expect(fileChangeKindLabel(undefined)).toBe("update");
    expect(fileChangeKindLabel({})).toBe("update");
  });
});

describe("normalizeFileChangeDiff", () => {
  it("passes through a real unified diff unchanged", () => {
    expect(normalizeFileChangeDiff({ diff: "@@ -1 +1 @@\n-a\n+b" }, "update")).toBe("@@ -1 +1 @@\n-a\n+b");
  });

  it("converts raw add content into +-prefixed lines", () => {
    expect(normalizeFileChangeDiff({ diff: "line1\nline2\n" }, "add")).toBe("+line1\n+line2");
  });

  it("converts raw delete content into --prefixed lines", () => {
    expect(normalizeFileChangeDiff({ diff: "gone\n" }, "delete")).toBe("-gone");
  });

  it("returns undefined when no diff is present", () => {
    expect(normalizeFileChangeDiff({}, "add")).toBeUndefined();
    expect(normalizeFileChangeDiff({ diff: "" }, "add")).toBeUndefined();
  });
});

describe("normalizeWebSearchItem", () => {
  it("maps a search action to a WebSearch tool call", () => {
    const out = normalizeWebSearchItem({ query: "latest Vite release", action: { type: "search", query: "latest Vite release" } });
    expect(out.name).toBe("WebSearch");
    expect(out.input).toEqual({ query: "latest Vite release" });
    expect(out.summary).toBe("Searched web for: latest Vite release");
  });

  it("maps an openPage action to a WebFetch tool call", () => {
    const out = normalizeWebSearchItem({ query: "OpenAI docs", action: { type: "openPage", url: "https://platform.openai.com/docs" } });
    expect(out.name).toBe("WebFetch");
    expect(out.input).toEqual({ url: "https://platform.openai.com/docs", query: "OpenAI docs" });
    expect(out.summary).toBe("Fetched https://platform.openai.com/docs");
  });
});

describe("isAskUserQuestionTool (docs/147)", () => {
  it("matches the bare name and server-qualified forms", () => {
    expect(isAskUserQuestionTool("AskUserQuestion")).toBe(true);
    expect(isAskUserQuestionTool("shipit__AskUserQuestion")).toBe(true);
    expect(isAskUserQuestionTool("shipit.AskUserQuestion")).toBe(true);
    expect(isAskUserQuestionTool("shipit/AskUserQuestion")).toBe(true);
  });

  it("does not match other tools or an undefined tool", () => {
    expect(isAskUserQuestionTool("present")).toBe(false);
    expect(isAskUserQuestionTool(undefined)).toBe(false);
  });
});
