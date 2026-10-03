// This tree is imported by the client; keep Node dependencies out.
import { HARNESSES } from "./harnesses.js";
import { MODEL_FAMILY_IDS } from "./model-identity.js";
import { MODEL_VISION, type VisionSupport } from "./model-vision.js";
import { SERVICES, type ServiceId } from "./services.js";
import {
  API_STYLES,
  type ApiStyle,
  type BillingMode,
  type BillingModeDef,
  type ContextWindow,
  type HarnessId,
  type ModelDef,
  type ModelPrice,
  type RetiredModel,
  type ServiceDef,
} from "./types.js";

/**
 * docs/318 — the model list published on `main`. It carries models only: a
 * service, an endpoint or a credential rule in it is never read (req 4).
 */
export const MODEL_LIST_SCHEMA = 1;

/** Repository-relative. Every install fetches this path from `main`, so moving the file strands them. */
export const MODEL_LIST_REPO_PATH = "src/server/shared/catalogue/models.json";

export interface ModelListBlock {
  models: ModelDef[];
  retired: RetiredModel[];
}

export interface ModelListDoc {
  schema: typeof MODEL_LIST_SCHEMA;
  services: Record<string, Partial<Record<BillingMode, ModelListBlock>>>;
  vision: Record<string, VisionSupport>;
}

export interface ParsedModelList {
  doc: ModelListDoc;
  /** One line per row this build cannot run, for the log. */
  dropped: string[];
}

export type LiveServiceDef = ServiceDef & { id: ServiceId };

let liveServices: readonly LiveServiceDef[] = SERVICES;
let liveVision: Readonly<Record<string, VisionSupport>> = MODEL_VISION;
let activeDoc: ModelListDoc | undefined;

export function servicesLive(): readonly LiveServiceDef[] {
  return liveServices;
}

export function visionLive(canonicalModelKey: string): VisionSupport {
  return liveVision[canonicalModelKey] ?? "unverified";
}

/** The published list in effect, or `undefined` while the embedded one is. */
export function activeModelList(): ModelListDoc | undefined {
  return activeDoc;
}

/** Pass only a document from {@link parseModelList}; `undefined` restores the embedded list. */
export function applyModelList(doc: ModelListDoc | undefined): void {
  activeDoc = doc;
  liveVision = doc ? { ...MODEL_VISION, ...doc.vision } : MODEL_VISION;
  liveServices = doc
    ? SERVICES.map((service): LiveServiceDef => {
        const blocks = doc.services[service.id];
        if (!blocks) return service;
        return {
          ...service,
          modes: service.modes.map((mode): BillingModeDef => {
            const block = blocks[mode.kind];
            return block ? { ...mode, models: block.models, retired: block.retired } : mode;
          }),
        };
      })
    : SERVICES;
}

/** Spread into a payload for another process; absent while the embedded list is in effect. */
export function modelListField(): { modelList?: ModelListDoc } {
  return activeDoc ? { modelList: activeDoc } : {};
}

/**
 * Adopt the list another process sent: the orchestrator's, in a browser or a
 * session worker. An absent one leaves the list in effect alone.
 */
export function adoptModelList(raw: unknown): void {
  if (raw === undefined) return;
  const parsed = parseModelList(raw);
  if (parsed) applyModelList(parsed.doc);
}

/** The embedded list as a document: what `models.json` holds. */
export function exportModelList(): ModelListDoc {
  const services: ModelListDoc["services"] = {};
  for (const service of SERVICES) {
    const blocks: Partial<Record<BillingMode, ModelListBlock>> = {};
    for (const mode of service.modes) {
      blocks[mode.kind] = {
        models: mode.models.map(exportModel),
        retired: mode.retired.map((r) => ({
          id: r.id,
          styles: [...r.styles],
          successors: { ...r.successors },
        })),
      };
    }
    services[service.id] = blocks;
  }
  return { schema: MODEL_LIST_SCHEMA, services, vision: { ...MODEL_VISION } };
}

// A fixed key order keeps the committed file byte-stable.
function exportModel(model: ModelDef): ModelDef {
  return {
    id: model.id,
    ...(model.apiId !== undefined ? { apiId: model.apiId } : {}),
    label: model.label,
    canonicalModelKey: model.canonicalModelKey,
    family: model.family,
    ...(model.harnesses !== undefined ? { harnesses: [...model.harnesses] } : {}),
    styles: [...model.styles],
    price: { ...model.price },
    contextWindow: {
      default: model.contextWindow.default,
      ...(model.contextWindow.byHarness ? { byHarness: { ...model.contextWindow.byHarness } } : {}),
    },
    ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
  };
}

/** One row per line: a merge to `main` is live on every install, so its diff must read at a glance. */
export function serializeModelList(doc: ModelListDoc): string {
  const rows: string[] = [];
  const placeholder = (row: unknown): string => `\u0000${rows.push(JSON.stringify(row)) - 1}\u0000`;
  const services = Object.fromEntries(
    Object.entries(doc.services).map(([id, blocks]) => [
      id,
      Object.fromEntries(
        Object.entries(blocks).map(([kind, block]) => [
          kind,
          { models: block.models.map(placeholder), retired: block.retired.map(placeholder) },
        ]),
      ),
    ]),
  );
  const text = JSON.stringify({ ...doc, services }, null, 2);
  return `${text.replace(/"\\u0000(\d+)\\u0000"/g, (_, i: string) => rows[Number(i)])}\n`;
}

/**
 * Keeps only what this build can run. A document in another schema is refused
 * whole; a bad row is dropped and the rest stays; a block left with no model
 * is left out, so the embedded block stands for it.
 */
export function parseModelList(raw: unknown): ParsedModelList | undefined {
  if (!isRecord(raw) || raw.schema !== MODEL_LIST_SCHEMA || !isRecord(raw.services)) return undefined;
  const dropped: string[] = [];
  const services: ModelListDoc["services"] = {};
  for (const id of Object.keys(raw.services)) {
    if (!SERVICES.some((s) => s.id === id)) dropped.push(`service ${id}: not in this build`);
  }
  for (const service of SERVICES) {
    const rawService = raw.services[service.id];
    if (!isRecord(rawService)) continue;
    for (const mode of service.modes) {
      const rawBlock = rawService[mode.kind];
      if (!isRecord(rawBlock)) continue;
      const block = parseBlock(`${service.id}:${mode.kind}`, mode, rawBlock, dropped);
      if (block) (services[service.id] ??= {})[mode.kind] = block;
    }
  }
  return { doc: { schema: MODEL_LIST_SCHEMA, services, vision: parseVision(raw.vision) }, dropped };
}

function parseBlock(
  where: string,
  mode: BillingModeDef,
  raw: Record<string, unknown>,
  dropped: string[],
): ModelListBlock | undefined {
  const models: ModelDef[] = [];
  for (const row of Array.isArray(raw.models) ? raw.models : []) {
    const model = parseModel(row, mode);
    const id = isRecord(row) && typeof row.id === "string" ? row.id : "?";
    if (typeof model === "string") dropped.push(`${where} model ${id}: ${model}`);
    else if (models.some((m) => m.id === model.id)) dropped.push(`${where} model ${id}: duplicate`);
    else models.push(model);
  }
  if (models.length === 0) {
    dropped.push(`${where}: no usable model, keeping the embedded list`);
    return undefined;
  }
  const retired: RetiredModel[] = [];
  for (const row of Array.isArray(raw.retired) ? raw.retired : []) {
    const entry = parseRetired(row, models);
    const id = isRecord(row) && typeof row.id === "string" ? row.id : "?";
    if (typeof entry === "string") dropped.push(`${where} retired ${id}: ${entry}`);
    else retired.push(entry);
  }
  return { models, retired };
}

const HARNESS_IDS: readonly string[] = HARNESSES.map((h) => h.id);
const FAMILY_IDS: readonly string[] = MODEL_FAMILY_IDS;
const STYLE_IDS: readonly string[] = API_STYLES;
const VISION_VALUES: readonly string[] = ["yes", "no", "unverified"] satisfies VisionSupport[];

/** A row, or why it cannot run on this build. */
function parseModel(raw: unknown, mode: BillingModeDef): ModelDef | string {
  if (!isRecord(raw)) return "not an object";
  const { id, apiId, label, canonicalModelKey, family, harnesses, reasoningEfforts } = raw;
  if (!isText(id) || !isText(label) || !isText(canonicalModelKey)) return "missing id, label or canonicalModelKey";
  if (apiId !== undefined && !isText(apiId)) return "bad apiId";
  if (typeof family !== "string" || !FAMILY_IDS.includes(family)) return `unknown family ${String(family)}`;
  const styles = parseStyles(raw.styles);
  if (!styles) return "unknown style";
  // Without an endpoint for the style, a spawn would have no URL.
  if (styles.some((s) => !mode.endpoints[s])) return "style without an endpoint in this mode";
  const price = parsePrice(raw.price);
  if (!price) return "bad price";
  const contextWindow = parseContextWindow(raw.contextWindow);
  if (!contextWindow) return "bad contextWindow";
  if (harnesses !== undefined && !Array.isArray(harnesses)) return "bad harnesses";
  if (reasoningEfforts !== undefined && !isTextArray(reasoningEfforts)) return "bad reasoningEfforts";
  // Narrowing only removes harnesses, so an unknown one cannot widen the row.
  const carriers = harnesses?.filter((h): h is HarnessId => typeof h === "string" && HARNESS_IDS.includes(h));
  // A block of rows nothing can run would replace a working one.
  const runnable = HARNESSES.some(
    (h) => (!carriers || carriers.includes(h.id)) && h.styles.some((s) => styles.includes(s)),
  );
  if (!runnable) return "no harness speaks its style";
  return {
    id,
    ...(apiId !== undefined ? { apiId } : {}),
    label,
    canonicalModelKey,
    family: family as ModelDef["family"],
    ...(carriers !== undefined ? { harnesses: carriers } : {}),
    styles,
    price,
    contextWindow,
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
  };
}

function parseRetired(raw: unknown, models: readonly ModelDef[]): RetiredModel | string {
  if (!isRecord(raw) || !isText(raw.id)) return "missing id";
  const styles = parseStyles(raw.styles);
  if (!styles) return "unknown style";
  if (!isRecord(raw.successors)) return "missing successors";
  const successors: Partial<Record<ApiStyle, string>> = {};
  for (const style of styles) {
    const successor = raw.successors[style];
    if (!models.some((m) => m.id === successor && m.styles.includes(style))) {
      return `no current successor for ${style}`;
    }
    successors[style] = successor as string;
  }
  return { id: raw.id, styles, successors };
}

function parseStyles(raw: unknown): ApiStyle[] | undefined {
  if (!isTextArray(raw) || raw.length === 0) return undefined;
  return raw.every((s) => STYLE_IDS.includes(s)) ? (raw as ApiStyle[]) : undefined;
}

function parsePrice(raw: unknown): ModelPrice | undefined {
  if (!isRecord(raw)) return undefined;
  const { input, output, cacheRead, cacheWrite } = raw;
  // Zero is a real price; the catalogue's negative "unknown" sentinel never ships.
  if (![input, output, cacheRead, cacheWrite].every((n) => isFiniteNumber(n) && n >= 0)) return undefined;
  return { input, output, cacheRead, cacheWrite } as ModelPrice;
}

function parseContextWindow(raw: unknown): ContextWindow | undefined {
  if (!isRecord(raw) || !isPositive(raw.default)) return undefined;
  if (raw.byHarness === undefined) return { default: raw.default };
  if (!isRecord(raw.byHarness)) return undefined;
  const byHarness: Partial<Record<HarnessId, number>> = {};
  for (const [harness, tokens] of Object.entries(raw.byHarness)) {
    if (!HARNESS_IDS.includes(harness)) continue;
    if (!isPositive(tokens)) return undefined;
    byHarness[harness as HarnessId] = tokens;
  }
  return { default: raw.default, byHarness };
}

function parseVision(raw: unknown): Record<string, VisionSupport> {
  const out: Record<string, VisionSupport> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && VISION_VALUES.includes(value)) out[key] = value as VisionSupport;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
