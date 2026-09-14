import { getErrorMessage } from "../../shared/utils.js";
import type { UpdateNotice, UpdateNoticeRecord, VersionInfo } from "../../shared/types.js";
import { checkForUpdates, type UpdateStatus } from "./updates.js";

/** docs/304 req 1 — a successful check is good for a day. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A failed check (offline, no host repo) retries hourly instead of every tick. */
export const UPDATE_CHECK_RETRY_MS = 60 * 60 * 1000;
/** How often the orchestrator asks whether a check is due. */
export const UPDATE_CHECK_TICK_MS = 30 * 60 * 1000;

export interface UpdateNoticeStore {
  getUpdateNotice(anchor: string): UpdateNoticeRecord | null;
  setUpdateNotice(record: UpdateNoticeRecord): void;
}

export interface UpdateNoticeDeps {
  store: UpdateNoticeStore;
  /** Identifies the running build; see `versionAnchor`. */
  anchor: string;
  /** `null` means "nothing known" — viewers must clear a banner on it, not keep the last one. */
  broadcast: (notice: UpdateNotice | null) => void;
  checkUpdates?: () => Promise<UpdateStatus>;
  now?: () => number;
}

/**
 * What "the version we are running" means for the record. The commit is the
 * running image's, not the checkout's (`build-id.ts`), so a half-finished
 * update that moved the checkout does not read as a performed update.
 */
export function versionAnchor(version: VersionInfo | undefined): string {
  return version?.commit ?? version?.version ?? "unknown";
}

/** Milliseconds since `iso`, or `null` when it is missing, unparsable, or in the future. */
function elapsedSince(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at > nowMs) return null;
  return nowMs - at;
}

export function isCheckDue(record: UpdateNoticeRecord | null, nowMs: number): boolean {
  if (!record) return true;
  const sinceAttempt = elapsedSince(record.lastAttemptAt, nowMs);
  if (sinceAttempt !== null && sinceAttempt < UPDATE_CHECK_RETRY_MS) return false;
  const sinceCheck = elapsedSince(record.lastCheckedAt, nowMs);
  return sinceCheck === null || sinceCheck >= UPDATE_CHECK_INTERVAL_MS;
}

function toNotice(record: UpdateNoticeRecord): UpdateNotice | null {
  if (!record.result) return null;
  return { ...record.result, dismissed: record.dismissed === true };
}

/** The notice a newly-connected viewer should be shown, or `null` if nothing is known yet. */
export function currentUpdateNotice(store: UpdateNoticeStore, anchor: string): UpdateNotice | null {
  const record = store.getUpdateNotice(anchor);
  return record ? toNotice(record) : null;
}

/**
 * Runs the check, records it, and broadcasts the result — the single act every
 * caller performs, so a manual check and the daily one cannot disagree about
 * when the day was last checked. Rethrows what `checkForUpdates` throws.
 *
 * A git fetch is long enough for the record to change underneath it, so the
 * attempt doubles as a claim: written before the fetch, re-read after. A caller
 * whose claim was taken over returns its status but records nothing — it is
 * answering a question the install has stopped asking.
 */
export async function checkUpdatesAndRecord(deps: UpdateNoticeDeps): Promise<UpdateStatus> {
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  const claimed = deps.store.getUpdateNotice(deps.anchor);
  deps.store.setUpdateNotice({ ...(claimed ?? {}), anchor: deps.anchor, lastAttemptAt: at });

  const status = await (deps.checkUpdates ?? checkForUpdates)();

  // Re-read: a dismissal landing mid-fetch must not be overwritten by the
  // record that was read before it existed (req 4).
  const current = deps.store.getUpdateNotice(deps.anchor);
  if (current && current.lastAttemptAt !== at) return status;

  // A downgrade is not a newer version (req 6); Settings warns about it separately.
  const result = { available: status.available && !status.isDowngrade, latestVersion: status.latestVersion };
  const record: UpdateNoticeRecord = {
    ...(current ?? {}),
    anchor: deps.anchor,
    lastCheckedAt: at,
    lastAttemptAt: at,
    result,
  };
  deps.store.setUpdateNotice(record);
  deps.broadcast({ ...result, dismissed: record.dismissed === true });
  return status;
}

/**
 * Forgets what the last check found, without touching the dismissal. The
 * channel decides what "latest" means, so on a switch the old channel's answer
 * is not a worse answer — it is an answer to a different question.
 */
export function invalidateUpdateResult(deps: UpdateNoticeDeps): void {
  const current = deps.store.getUpdateNotice(deps.anchor);
  if (!current?.result) return;
  const { result: _dropped, ...rest } = current;
  deps.store.setUpdateNotice({ ...rest, anchor: deps.anchor });
  deps.broadcast(null);
}

/** The daily tick. Never throws: a background check must not be louder than what it checks for. */
export async function runUpdateCheckIfDue(deps: UpdateNoticeDeps): Promise<void> {
  const nowMs = deps.now?.() ?? Date.now();
  if (!isCheckDue(deps.store.getUpdateNotice(deps.anchor), nowMs)) return;
  try {
    await checkUpdatesAndRecord(deps);
  } catch (err) {
    console.warn(`[update-notice] background check failed: ${getErrorMessage(err)}`);
  }
}

/**
 * Silences update notices for this install until it is running different code
 * (req 4, req 8). Nothing here expires the dismissal — `getUpdateNotice`
 * discards the whole record once the running build's anchor changes.
 */
export function dismissUpdateNotice(deps: UpdateNoticeDeps): UpdateNotice | null {
  const previous = deps.store.getUpdateNotice(deps.anchor);
  const record: UpdateNoticeRecord = { ...(previous ?? {}), anchor: deps.anchor, dismissed: true };
  deps.store.setUpdateNotice(record);
  const notice = toNotice(record);
  if (notice) deps.broadcast(notice);
  return notice;
}
