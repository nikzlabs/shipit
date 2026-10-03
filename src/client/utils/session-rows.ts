import type { SessionListRow } from "../../server/shared/types.js";

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  return keysA.every((key) => Object.hasOwn(objB, key) && sameJson(objA[key], objB[key]));
}

/**
 * Keeps the previous object for each row that did not change, and the previous array when
 * no row did. Every `session_list` arrives as new objects, so without this each one
 * re-renders every component that selects a row.
 */
export function reuseUnchangedRows<T extends SessionListRow>(prev: T[], next: T[]): T[] {
  const byId = new Map(prev.map((row) => [row.id, row]));
  let changed = prev.length !== next.length;
  const rows = next.map((row, i) => {
    const old = byId.get(row.id);
    const kept = old && sameJson(old, row) ? old : row;
    if (kept !== prev[i]) changed = true;
    return kept;
  });
  return changed ? rows : prev;
}
