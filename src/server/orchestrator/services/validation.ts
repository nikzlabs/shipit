import { ServiceError } from "./types.js";

export function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ServiceError(400, `${fieldName} must be a string`);
  }
  return value;
}

export function validateStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ServiceError(400, `${fieldName} must be an array of strings`);
  }
  return value as string[];
}

export function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServiceError(400, `${fieldName} must be a non-empty string`);
  }
  return value;
}
