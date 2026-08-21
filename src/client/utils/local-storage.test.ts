import { describe, it, expect, beforeEach } from "vitest";
import {
  getSavedKeybindings,
  saveKeybindings,
  getSavedChangedDocsExpanded,
  saveChangedDocsExpanded,
  getSavedDraftUploads,
  saveDraftUploads,
  addDraftUpload,
  removeDraftUploads,
  parseJsonWithFallback,
  getLocalStorageObject,
  getSavedQuickSessionRepo,
  saveQuickSessionRepo,
  LAST_QUICK_SESSION_REPO_KEY,
  getSavedModelId,
  getSavedModelSelection,
  saveModelId,
  saveModelSelection,
} from "./local-storage.js";

beforeEach(() => {
  localStorage.clear();
});

describe("parseJsonWithFallback", () => {
  it("round-trips valid JSON", () => {
    expect(parseJsonWithFallback('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJsonWithFallback("[1,2,3]", [])).toEqual([1, 2, 3]);
  });

  it("returns the fallback for null/empty input", () => {
    expect(parseJsonWithFallback(null, { def: true })).toEqual({ def: true });
    expect(parseJsonWithFallback("", { def: true })).toEqual({ def: true });
  });

  it("returns the fallback for malformed JSON", () => {
    expect(parseJsonWithFallback("not json", { def: 1 })).toEqual({ def: 1 });
    expect(parseJsonWithFallback("{unclosed", [])).toEqual([]);
  });

  it("applies the validate transform to the parsed value", () => {
    const out = parseJsonWithFallback<Record<string, string>>(
      JSON.stringify({ a: "x", b: 2, c: "y" }),
      {},
      (parsed) => {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") result[k] = v;
        }
        return result;
      },
    );
    expect(out).toEqual({ a: "x", c: "y" });
  });

  it("returns the fallback when validate throws", () => {
    expect(
      parseJsonWithFallback(JSON.stringify(5), new Set<string>(), (parsed) => new Set(parsed as string[])),
    ).toEqual(new Set());
  });
});

describe("getLocalStorageObject", () => {
  it("round-trips valid JSON stored under a key", () => {
    localStorage.setItem("k", JSON.stringify({ a: 1, b: 2 }));
    expect(getLocalStorageObject("k", {})).toEqual({ a: 1, b: 2 });
  });

  it("returns the fallback for a missing key", () => {
    expect(getLocalStorageObject("absent", { def: true })).toEqual({ def: true });
  });

  it("returns the fallback for a malformed stored blob", () => {
    localStorage.setItem("k", "not json");
    expect(getLocalStorageObject("k", { def: 1 })).toEqual({ def: 1 });
  });

  it("applies the transform to the parsed value", () => {
    localStorage.setItem("k", JSON.stringify(["a", "b", "a"]));
    expect(getLocalStorageObject<Set<string>>("k", new Set(), (parsed) => new Set(parsed as string[]))).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("returns the fallback when the transform throws", () => {
    localStorage.setItem("k", JSON.stringify(42));
    expect(
      getLocalStorageObject<Set<string>>("k", new Set(), (parsed) => new Set(parsed as string[])),
    ).toEqual(new Set());
  });
});

describe("draft uploads (attached-but-unsent chips)", () => {
  it("returns [] when nothing is stored", () => {
    expect(getSavedDraftUploads("s1")).toEqual([]);
  });

  it("round-trips and scopes paths per session", () => {
    saveDraftUploads("s1", ["/uploads/a.png", "/uploads/b.csv"]);
    saveDraftUploads("s2", ["/uploads/c.txt"]);
    expect(getSavedDraftUploads("s1")).toEqual(["/uploads/a.png", "/uploads/b.csv"]);
    expect(getSavedDraftUploads("s2")).toEqual(["/uploads/c.txt"]);
    expect(getSavedDraftUploads("s3")).toEqual([]);
  });

  it("clears the key when saved empty", () => {
    saveDraftUploads("s1", ["/uploads/a.png"]);
    saveDraftUploads("s1", []);
    expect(getSavedDraftUploads("s1")).toEqual([]);
    expect(localStorage.getItem("shipit-draft-uploads:s1")).toBeNull();
  });

  it("addDraftUpload appends without duplicating", () => {
    addDraftUpload("s1", "/uploads/a.png");
    addDraftUpload("s1", "/uploads/a.png");
    addDraftUpload("s1", "/uploads/b.png");
    expect(getSavedDraftUploads("s1")).toEqual(["/uploads/a.png", "/uploads/b.png"]);
  });

  it("removeDraftUploads drops the named paths, leaving others", () => {
    saveDraftUploads("s1", ["/uploads/a.png", "/uploads/b.png", "/uploads/c.png"]);
    removeDraftUploads("s1", ["/uploads/a.png", "/uploads/c.png"]);
    expect(getSavedDraftUploads("s1")).toEqual(["/uploads/b.png"]);
  });

  it("ignores a corrupt stored blob", () => {
    localStorage.setItem("shipit-draft-uploads:s1", "not json");
    expect(getSavedDraftUploads("s1")).toEqual([]);
  });
});

describe("changed-docs strip collapse state (docs/205)", () => {
  it("defaults to collapsed when no preference is stored", () => {
    expect(getSavedChangedDocsExpanded("s1")).toBe(false);
  });

  it("falls back to the caller-supplied default when no preference is stored", () => {
    // Desktop passes `true`, mobile passes `false`.
    expect(getSavedChangedDocsExpanded("s1", true)).toBe(true);
    expect(getSavedChangedDocsExpanded("s1", false)).toBe(false);
  });

  it("lets a stored preference win over the supplied default", () => {
    saveChangedDocsExpanded("s1", false);
    expect(getSavedChangedDocsExpanded("s1", true)).toBe(false);
  });

  it("persists expanded state per session independently", () => {
    saveChangedDocsExpanded("s1", true);
    saveChangedDocsExpanded("s2", false);
    expect(getSavedChangedDocsExpanded("s1")).toBe(true);
    expect(getSavedChangedDocsExpanded("s2")).toBe(false);
    // A session with no entry still defaults to collapsed.
    expect(getSavedChangedDocsExpanded("s3")).toBe(false);
  });

  it("round-trips a collapse after an expand", () => {
    saveChangedDocsExpanded("s1", true);
    expect(getSavedChangedDocsExpanded("s1")).toBe(true);
    saveChangedDocsExpanded("s1", false);
    expect(getSavedChangedDocsExpanded("s1")).toBe(false);
  });

  it("ignores a corrupt stored blob", () => {
    localStorage.setItem("shipit-changed-docs-expanded-by-session", "not json");
    expect(getSavedChangedDocsExpanded("s1")).toBe(false);
  });
});

describe("last quick-session repo (docs/145)", () => {
  it("round-trips the remembered repo", () => {
    expect(getSavedQuickSessionRepo()).toBeUndefined();
    saveQuickSessionRepo("https://github.com/acme/shipit.git");
    expect(localStorage.getItem(LAST_QUICK_SESSION_REPO_KEY)).toBe("https://github.com/acme/shipit.git");
    expect(getSavedQuickSessionRepo()).toBe("https://github.com/acme/shipit.git");
  });

  it("clears the key when saving undefined", () => {
    saveQuickSessionRepo("https://github.com/acme/shipit.git");
    saveQuickSessionRepo(undefined);
    expect(localStorage.getItem(LAST_QUICK_SESSION_REPO_KEY)).toBeNull();
    expect(getSavedQuickSessionRepo()).toBeUndefined();
  });
});

describe("getSavedKeybindings (docs/180)", () => {
  it("returns {} with no stored data", () => {
    expect(getSavedKeybindings()).toEqual({});
  });

  it("reads the keybindings blob", () => {
    saveKeybindings({ "new-session": "mod+shift+k" });
    expect(getSavedKeybindings()).toEqual({ "new-session": "mod+shift+k" });
  });

  it("migrates legacy per-key entries when no blob exists", () => {
    localStorage.setItem("shipit-quick-capture-hotkey", "mod+alt+j");
    localStorage.setItem("shipit-voice-hotkey-mode-a", "ctrl+shift+u");
    localStorage.setItem("shipit-voice-hotkey-mode-b", "ctrl+shift+y");
    expect(getSavedKeybindings()).toEqual({
      "quick-capture": "mod+alt+j",
      "voice-mode-a": "ctrl+shift+u",
      "voice-mode-b": "ctrl+shift+y",
    });
  });

  it("prefers the blob over legacy keys once it exists", () => {
    localStorage.setItem("shipit-quick-capture-hotkey", "mod+alt+j");
    saveKeybindings({ "new-session": "mod+shift+k" });
    // Blob present → legacy keys are ignored.
    expect(getSavedKeybindings()).toEqual({ "new-session": "mod+shift+k" });
  });

  it("ignores non-string blob values", () => {
    localStorage.setItem("shipit-keybindings", JSON.stringify({ "new-session": 42, "quick-capture": "mod+alt+n" }));
    expect(getSavedKeybindings()).toEqual({ "quick-capture": "mod+alt+n" });
  });
});


/**
 * docs/252 — `vibe-model-id` is the seed for every NEW session's model, so a
 * bare id there silently decides what a fresh session bills to the moment one id
 * belongs to two services. The slot holds the serialized triple, and a value
 * written by an older build migrates in place on first read.
 */
describe("model selection seed (docs/252)", () => {
  const KEY = "vibe-model-id";

  it("stores a picked model as the full triple", () => {
    saveModelId("claude-opus-5");
    expect(localStorage.getItem(KEY)).toBe("anthropic:sub:claude-opus-5");
    expect(getSavedModelSelection()).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
  });

  it("still reports a BARE model id, which is what the picker and `?model=` take", () => {
    saveModelId("claude-opus-5");
    expect(getSavedModelId()).toBe("claude-opus-5");
  });

  it("migrates a legacy bare id in place on first read", () => {
    localStorage.setItem(KEY, "gpt-5.6-sol");
    expect(getSavedModelSelection()).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    // Written back, so the migration happens once rather than on every read.
    expect(localStorage.getItem(KEY)).toBe("openai:sub:gpt-5.6-sol");
  });

  it("leaves a legacy id the catalogue cannot place readable and unmigrated", () => {
    // A versioned slug the picker never surfaced. The seed must still work —
    // degrading to today's behaviour — rather than being dropped.
    localStorage.setItem(KEY, "claude-sonnet-4-20250514");
    expect(getSavedModelSelection()).toBeUndefined();
    expect(getSavedModelId()).toBe("claude-sonnet-4-20250514");
    expect(localStorage.getItem(KEY)).toBe("claude-sonnet-4-20250514");
  });

  it("round-trips a selection the picker could not have expressed as an id", () => {
    // The whole point of the triple: same model id, different service.
    saveModelSelection({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
    expect(getSavedModelSelection()?.serviceId).toBe("openrouter");
    expect(getSavedModelId()).toBe("anthropic/claude-opus-5");
  });

  it("refuses a triple naming no catalogue row, on read and on write", () => {
    // Syntax is not existence. A value written by a build whose catalogue carried
    // a service this one has dropped still parses; returning it would seed a new
    // session with a row nothing can resolve an endpoint from.
    localStorage.setItem(KEY, "obsolete:key:gpt-5.6-sol");
    expect(getSavedModelSelection()).toBeUndefined();

    localStorage.clear();
    saveModelSelection({ serviceId: "obsolete", billingMode: "key", modelId: "gpt-5.6-sol" });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("clears the slot", () => {
    saveModelId("claude-opus-5");
    saveModelId(undefined);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getSavedModelSelection()).toBeUndefined();
    expect(getSavedModelId()).toBeUndefined();
  });
});
