/**
 * Param type-validation helpers for the service layer.
 *
 * Services receive request payloads typed as `unknown`/loose shapes from the
 * wire and must narrow them before use. The same handful of guards —
 * "must be a string", "must be a number", "must be an array of strings",
 * "must be a non-empty string" — were repeated 20+ times across services,
 * each one throwing a `ServiceError(400, …)` by hand. These helpers collapse
 * that pattern: each narrows `value` and RETURNS the typed value (throwing a
 * 400 `ServiceError` otherwise) so call sites stay a single line.
 *
 * Co-located with `ServiceError` (`./types.js`) so the validation surface and
 * its error type live together.
 */

import { ServiceError } from "./types.js";

/** Narrow `value` to `string`, or throw a 400 ServiceError. */
export function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ServiceError(400, `${fieldName} must be a string`);
  }
  return value;
}

/** Narrow `value` to a finite `number`, or throw a 400 ServiceError. */
export function validateNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ServiceError(400, `${fieldName} must be a number`);
  }
  return value;
}

/** Narrow `value` to `string[]` (array whose every entry is a string), or throw a 400 ServiceError. */
export function validateStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ServiceError(400, `${fieldName} must be an array of strings`);
  }
  return value as string[];
}

/** Narrow `value` to a non-empty (non-whitespace) `string`, or throw a 400 ServiceError. */
export function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServiceError(400, `${fieldName} must be a non-empty string`);
  }
  return value;
}
