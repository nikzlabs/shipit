import fs from "node:fs";
import path from "node:path";
import {
  MODEL_LIST_REPO_PATH,
  activeModelList,
  applyModelList,
  parseModelList,
  serializeModelList,
} from "../../shared/catalogue/index.js";
import { getErrorMessage } from "../../shared/utils.js";
import { UPSTREAM_REPO } from "./bug-report.js";

/** docs/318 req 2. */
export const PUBLISHED_MODEL_LIST_URL =
  `https://raw.githubusercontent.com/${UPSTREAM_REPO.owner}/${UPSTREAM_REPO.repo}/main/${MODEL_LIST_REPO_PATH}`;

/**
 * docs/318 req 5 allows an hour. Half of it, because the CDN in front of
 * raw.githubusercontent.com serves a merged file up to five minutes late.
 */
export const MODEL_LIST_REFRESH_MS = 30 * 60 * 1000;

export const MODEL_LIST_CACHE_FILE = ".shipit-model-list.json";

const FETCH_TIMEOUT_MS = 15_000;

export interface PublishedModelListDeps {
  stateDir: string;
  /** Re-derive what the model list feeds, and tell viewers. */
  onChange: () => void;
  fetchImpl?: typeof fetch;
}

export type RefreshOutcome = "changed" | "unchanged" | "failed";

/** docs/318 req 6 — the last list read survives a restart. Returns whether one was applied. */
export function loadCachedModelList(stateDir: string): boolean {
  const file = path.join(stateDir, MODEL_LIST_CACHE_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[model-list] ignoring unreadable ${file}: ${getErrorMessage(err)}`);
    }
    return false;
  }
  const parsed = parseModelList(raw);
  if (!parsed) {
    console.warn(`[model-list] ignoring ${file}: not a schema this build reads`);
    return false;
  }
  applyModelList(parsed.doc);
  return true;
}

/** A failed read changes nothing: the list in effect stays (docs/318 reqs 3, 6). */
export async function refreshPublishedModelList(deps: PublishedModelListDeps): Promise<RefreshOutcome> {
  let raw: unknown;
  try {
    const res = await (deps.fetchImpl ?? fetch)(PUBLISHED_MODEL_LIST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn(`[model-list] could not read the published model list: ${getErrorMessage(err)}`);
    return "failed";
  }
  const parsed = parseModelList(raw);
  if (!parsed) {
    console.warn("[model-list] the published model list is not in a schema this build reads");
    return "failed";
  }
  const next = serializeModelList(parsed.doc);
  // Also on an unchanged list, so a write that failed once is retried (req 6).
  writeCacheIfStale(deps.stateDir, next);
  const current = activeModelList();
  if (current && serializeModelList(current) === next) return "unchanged";
  if (parsed.dropped.length > 0) {
    console.warn(`[model-list] ignored what this build cannot run:\n  ${parsed.dropped.join("\n  ")}`);
  }
  applyModelList(parsed.doc);
  console.log("[model-list] applied the published model list");
  deps.onChange();
  return "changed";
}

function writeCacheIfStale(stateDir: string, text: string): void {
  const file = path.join(stateDir, MODEL_LIST_CACHE_FILE);
  const staging = `${file}.${process.pid}.tmp`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
    fs.writeFileSync(staging, text);
    fs.renameSync(staging, file);
  } catch (err) {
    // The list still applies; only its survival across a restart is lost.
    console.warn(`[model-list] could not write ${file}: ${getErrorMessage(err)}`);
  }
}
