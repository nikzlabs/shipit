import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeModelList,
  applyModelList,
  exportModelList,
  getModel,
  serializeModelList,
  type ModelDef,
} from "../../shared/catalogue/index.js";
import {
  MODEL_LIST_CACHE_FILE,
  PUBLISHED_MODEL_LIST_URL,
  loadCachedModelList,
  refreshPublishedModelList,
} from "./published-model-list.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { buildAgentListPayload } from "./settings.js";

const OPUS6 = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-6" } as const;

const NEW_MODEL: ModelDef = {
  id: "claude-opus-6",
  label: "Opus 6",
  canonicalModelKey: "claude-opus-6",
  family: "claude",
  styles: ["anthropic-messages"],
  price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: { default: 1_000_000 },
};

function publishedWithOpus6(): unknown {
  const doc = exportModelList();
  doc.services.anthropic?.sub?.models.push(NEW_MODEL);
  return JSON.parse(serializeModelList(doc));
}

function respondWith(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

let stateDir: string;
let onChange: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-list-"));
  onChange = vi.fn<() => void>();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  applyModelList(undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("refreshPublishedModelList", () => {
  it("reads the file from main in this repository", () => {
    expect(PUBLISHED_MODEL_LIST_URL).toBe(
      "https://raw.githubusercontent.com/nikzlabs/shipit/main/src/server/shared/catalogue/models.json",
    );
  });

  // reqs 1, 5
  it("applies a new list, keeps it on disk, and reports the change", async () => {
    const fetchImpl = respondWith(publishedWithOpus6());
    await expect(refreshPublishedModelList({ stateDir, onChange, fetchImpl })).resolves.toBe("changed");
    expect(fetchImpl).toHaveBeenCalledWith(PUBLISHED_MODEL_LIST_URL, expect.anything());
    expect(getModel(OPUS6)?.label).toBe("Opus 6");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(stateDir, MODEL_LIST_CACHE_FILE))).toBe(true);
  });

  it("does not report an unchanged list", async () => {
    await refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) });
    await expect(
      refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) }),
    ).resolves.toBe("unchanged");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // req 6 — a write that failed once must not leave the next restart on the embedded list.
  it("rewrites a missing cache even when the list is unchanged", async () => {
    await refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) });
    fs.rmSync(path.join(stateDir, MODEL_LIST_CACHE_FILE));

    await expect(
      refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) }),
    ).resolves.toBe("unchanged");
    applyModelList(undefined);
    expect(loadCachedModelList(stateDir)).toBe(true);
    expect(getModel(OPUS6)?.label).toBe("Opus 6");
  });

  // req 6
  it.each([
    ["a network error", vi.fn(async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch],
    ["an HTTP error", respondWith({}, 404)],
    ["a document in another schema", respondWith({ schema: 99, services: {} })],
  ])("keeps the last list read on %s", async (_, failing) => {
    await refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) });
    const cached = fs.readFileSync(path.join(stateDir, MODEL_LIST_CACHE_FILE), "utf8");

    await expect(refreshPublishedModelList({ stateDir, onChange, fetchImpl: failing })).resolves.toBe("failed");
    expect(getModel(OPUS6)?.label).toBe("Opus 6");
    expect(fs.readFileSync(path.join(stateDir, MODEL_LIST_CACHE_FILE), "utf8")).toBe(cached);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // req 3
  it("stays on the embedded list when it has never read one", async () => {
    const failing = respondWith({}, 500);
    await expect(refreshPublishedModelList({ stateDir, onChange, fetchImpl: failing })).resolves.toBe("failed");
    expect(activeModelList()).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, MODEL_LIST_CACHE_FILE))).toBe(false);
  });
});

// What startup-monitors' onChange relies on: a refresh re-derives eligibility,
// and the agent_list payload carries the list to viewers (req 5).
describe("after a change", () => {
  it("a refreshed registry offers the new model and the agent_list payload carries the list", async () => {
    const registry = new AgentRegistry({
      declaredHarnesses: () => ["claude"],
      listCredentials: () => [{ serviceId: "anthropic", billingMode: "sub", via: "account" }],
    });
    await registry.detect();
    expect(buildAgentListPayload(registry, undefined, undefined).modelList).toBeUndefined();

    await refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) });
    registry.refreshAuth("claude");

    const payload = buildAgentListPayload(registry, undefined, undefined);
    expect(registry.get("claude")?.eligibleModels.map((m) => m.modelId)).toContain("claude-opus-6");
    expect(payload.modelList).toEqual(activeModelList());
  });
});

describe("loadCachedModelList", () => {
  // req 6 — across a restart.
  it("applies the last list read", async () => {
    await refreshPublishedModelList({ stateDir, onChange, fetchImpl: respondWith(publishedWithOpus6()) });
    applyModelList(undefined);

    expect(loadCachedModelList(stateDir)).toBe(true);
    expect(getModel(OPUS6)?.label).toBe("Opus 6");
  });

  it("leaves the embedded list when there is no usable cache", () => {
    expect(loadCachedModelList(stateDir)).toBe(false);
    fs.writeFileSync(path.join(stateDir, MODEL_LIST_CACHE_FILE), "{ not json");
    expect(loadCachedModelList(stateDir)).toBe(false);
    expect(activeModelList()).toBeUndefined();
  });
});
