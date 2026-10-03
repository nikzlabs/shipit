import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_LIST_REPO_PATH,
  activeModelList,
  applyModelList,
  catalogueEntriesForHarness,
  contextWindowFor,
  exportModelList,
  getModel,
  parseModelList,
  reasoningOptionsFor,
  resolveEndpoint,
  retirementSuccessor,
  serializeModelList,
  visionSupportFor,
  type ModelDef,
  type ModelListDoc,
} from "./index.js";
import { claudeModelArg } from "../spawn-routing.js";
import { agentIdForModel, getAgentCapabilities } from "../agent-registry.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const NEW_MODEL: ModelDef = {
  id: "claude-opus-6",
  label: "Opus 6",
  canonicalModelKey: "claude-opus-6",
  family: "claude",
  styles: ["anthropic-messages"],
  price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: { default: 1_000_000 },
  reasoningEfforts: ["low", "high"],
};

const OPUS6 = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-6" } as const;

/** The embedded list with `rows` appended to anthropic's subscription block. */
function withAnthropicSubRows(rows: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const doc = JSON.parse(serializeModelList(exportModelList())) as Record<string, any>;
  doc.services.anthropic.sub.models.push(...rows);
  return { ...doc, ...extra };
}

function parsed(raw: unknown): ModelListDoc {
  const result = parseModelList(raw);
  if (!result) throw new Error("document refused");
  return result.doc;
}

afterEach(() => applyModelList(undefined));

describe("the published file", () => {
  it("is the export of the embedded catalogue", () => {
    const committed = fs.readFileSync(path.join(ROOT, MODEL_LIST_REPO_PATH), "utf8");
    expect(committed, "models.json is stale — run `npm run catalogue:export`").toBe(
      serializeModelList(exportModelList()),
    );
  });

  it("parses back without dropping a row", () => {
    const committed = fs.readFileSync(path.join(ROOT, MODEL_LIST_REPO_PATH), "utf8");
    const result = parseModelList(JSON.parse(committed));
    expect(result?.dropped).toEqual([]);
    expect(result?.doc).toEqual(exportModelList());
  });
});

describe("applyModelList", () => {
  it("makes a published model visible to every catalogue reader, and undefined restores the embedded list", () => {
    applyModelList(parsed(withAnthropicSubRows([NEW_MODEL], { vision: { "claude-opus-6": "no" } })));

    expect(getModel(OPUS6)?.label).toBe("Opus 6");
    expect(catalogueEntriesForHarness("claude").some((e) => e.model.id === "claude-opus-6")).toBe(true);
    expect(contextWindowFor(OPUS6)).toBe(1_000_000);
    expect(reasoningOptionsFor("claude", OPUS6).map((o) => o.value)).toEqual(["low", "high"]);
    expect(visionSupportFor(OPUS6)).toBe("no");
    expect(claudeModelArg("claude-opus-6")).toBe("claude-opus-6[1m]");
    expect(getAgentCapabilities("claude")?.models).toContain("claude-opus-6");
    expect(agentIdForModel("claude-opus-6")).toBe("claude");
    expect(activeModelList()).toBeDefined();

    applyModelList(undefined);
    expect(getModel(OPUS6)).toBeUndefined();
    expect(claudeModelArg("claude-opus-6")).toBe("claude-opus-6");
    expect(activeModelList()).toBeUndefined();
  });

  it("keeps the embedded vision verdicts the document does not name", () => {
    applyModelList(parsed(withAnthropicSubRows([], { vision: {} })));
    expect(visionSupportFor({ serviceId: "zai", billingMode: "key", modelId: "glm-5.2" })).toBe("no");
  });

  it("follows a published retirement", () => {
    const raw = withAnthropicSubRows([NEW_MODEL]) as Record<string, any>;
    raw.services.anthropic.sub.retired.push({
      id: "claude-opus-5",
      styles: ["anthropic-messages"],
      successors: { "anthropic-messages": "claude-opus-6" },
    });
    raw.services.anthropic.sub.models = raw.services.anthropic.sub.models.filter(
      (m: { id: string }) => m.id !== "claude-opus-5",
    );
    applyModelList(parsed(raw));
    expect(
      retirementSuccessor("claude", { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" }),
    ).toEqual(OPUS6);
  });
});

describe("parseModelList", () => {
  it("refuses a document in another schema, or not a document at all", () => {
    expect(parseModelList(withAnthropicSubRows([], { schema: 2 }))).toBeUndefined();
    expect(parseModelList(null)).toBeUndefined();
    expect(parseModelList("[]")).toBeUndefined();
  });

  // req 4 — the document can name models only.
  it("never reads a service, an endpoint or a credential from the document", () => {
    const raw = withAnthropicSubRows([NEW_MODEL]) as Record<string, any>;
    raw.services.evil = { key: { models: [NEW_MODEL], retired: [] } };
    raw.services.anthropic.sub.endpoints = { "anthropic-messages": "https://attacker.example" };
    raw.services.anthropic.sub.credentials = [{ via: "string", storageEnv: "ANTHROPIC_API_KEY" }];
    const result = parseModelList(raw);
    expect(result?.dropped).toContain("service evil: not in this build");
    applyModelList(result?.doc);
    expect(resolveEndpoint("claude", OPUS6)).toBe("https://api.anthropic.com");
  });

  it("drops a row this build cannot run and keeps the rest", () => {
    const rows = [
      { ...NEW_MODEL, id: "bad-family", family: "mistral" },
      { ...NEW_MODEL, id: "bad-style", styles: ["carrier-pigeon"] },
      // anthropic's subscription has no Chat Completions endpoint.
      { ...NEW_MODEL, id: "no-endpoint", styles: ["openai-chat-completions"] },
      { ...NEW_MODEL, id: "bad-price", price: { input: "5", output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
      { ...NEW_MODEL, id: "sentinel-price", price: { input: -1, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
      { ...NEW_MODEL, id: "no-window", contextWindow: {} },
      { ...NEW_MODEL, id: "sentinel-window", contextWindow: { default: -1 } },
      // Codex speaks no Anthropic Messages, so nothing could run this row.
      { ...NEW_MODEL, id: "unrunnable", harnesses: ["codex"] },
      { ...NEW_MODEL, label: "" },
      NEW_MODEL,
      { ...NEW_MODEL, label: "Opus 6 again" },
    ];
    const result = parseModelList(withAnthropicSubRows(rows));
    expect(result?.dropped).toEqual([
      "anthropic:sub model bad-family: unknown family mistral",
      "anthropic:sub model bad-style: unknown style",
      "anthropic:sub model no-endpoint: style without an endpoint in this mode",
      "anthropic:sub model bad-price: bad price",
      "anthropic:sub model sentinel-price: bad price",
      "anthropic:sub model no-window: bad contextWindow",
      "anthropic:sub model sentinel-window: bad contextWindow",
      "anthropic:sub model unrunnable: no harness speaks its style",
      "anthropic:sub model claude-opus-6: missing id, label or canonicalModelKey",
      "anthropic:sub model claude-opus-6: duplicate",
    ]);
    applyModelList(result?.doc);
    expect(getModel(OPUS6)?.label).toBe("Opus 6");
  });

  it("narrows harnesses to the ones this build has, never widening a row", () => {
    const doc = parsed(withAnthropicSubRows([{ ...NEW_MODEL, harnesses: ["claude", "future-cli"] }]));
    const row = doc.services.anthropic?.sub?.models.find((m) => m.id === "claude-opus-6");
    expect(row?.harnesses).toEqual(["claude"]);
  });

  it("drops a retirement whose successor is not a current model", () => {
    const raw = withAnthropicSubRows([]) as Record<string, any>;
    raw.services.anthropic.sub.retired.push({
      id: "claude-opus-4",
      styles: ["anthropic-messages"],
      successors: { "anthropic-messages": "claude-opus-9" },
    });
    const result = parseModelList(raw);
    expect(result?.dropped).toEqual(["anthropic:sub retired claude-opus-4: no current successor for anthropic-messages"]);
  });

  it("leaves out a block with no usable row, so the embedded block stands", () => {
    const raw = withAnthropicSubRows([]) as Record<string, any>;
    raw.services.anthropic.sub.models = [{ ...NEW_MODEL, family: "mistral" }];
    const result = parseModelList(raw);
    expect(result?.doc.services.anthropic?.sub).toBeUndefined();
    applyModelList(result?.doc);
    expect(getModel({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" })).toBeDefined();
  });

  it("drops a vision verdict it does not know", () => {
    const doc = parsed(withAnthropicSubRows([], { vision: { a: "yes", b: "maybe", c: 1 } }));
    expect(doc.vision).toEqual({ a: "yes" });
  });
});
