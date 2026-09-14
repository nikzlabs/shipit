import { getMode, selectionExists } from "../catalogue/index.js";
import type { ModelSelection } from "../catalogue/index.js";
import type { GitIdentity, SettingValueType, ValidationResult } from "./types.js";

// A declaration's `type` carries the value's default, its validation and the
// shape the detail view renders, so none of the three is authored twice.

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(message: string): ValidationResult<T> {
  return { ok: false, message };
}

export function bool(opts: { default: boolean }): SettingValueType<boolean> {
  return {
    kind: "bool",
    defaultValue: opts.default,
    shape: {},
    read(raw) {
      return typeof raw === "boolean" ? raw : opts.default;
    },
    validate(raw, noun) {
      return typeof raw === "boolean" ? ok(raw) : fail(`${noun} must be true or false`);
    },
    serialize(value) {
      return value;
    },
  };
}

export interface EnumOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

export function enumOf<const O extends readonly EnumOption<string>[]>(opts: {
  options: O;
  // Inferred from the options, so a default that is not one of them fails here.
  default: O[number]["value"];
}): SettingValueType<O[number]["value"]> {
  type T = O[number]["value"];
  const values = opts.options.map((o) => o.value);
  const isMember = (raw: unknown): raw is T =>
    typeof raw === "string" && values.includes(raw);
  return {
    kind: "enum",
    defaultValue: opts.default,
    shape: { options: opts.options },
    read(raw) {
      return isMember(raw) ? raw : opts.default;
    },
    validate(raw, noun) {
      return isMember(raw)
        ? ok(raw)
        : fail(`${noun} must be one of: ${values.join(", ")}`);
    },
    serialize(value) {
      return value;
    },
  };
}

interface NumberOpts {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  integer?: boolean;
  /**
   * A stored value below this reads as "not set", and writing one removes the
   * field — so a budget of zero falls back to the default rather than capping
   * the install at nothing.
   */
  unsetBelow?: number;
}

/**
 * `nullable` means "not set" is a value of its own — the stored field is removed
 * rather than written, which is how a budget falls back to the host's default.
 */
export function numeric(
  opts: NumberOpts & { nullable: true; default: number | null },
): SettingValueType<number | null>;
export function numeric(
  opts: NumberOpts & { nullable?: false; default: number },
): SettingValueType<number>;
export function numeric(
  opts: NumberOpts & { nullable?: boolean; default: number | null },
): SettingValueType<number | null> {
  const { min, max, step, unit, integer, nullable, unsetBelow } = opts;
  const inRange = (n: number): boolean =>
    (min === undefined || n >= min) && (max === undefined || n <= max);
  const isSet = (n: number): boolean => unsetBelow === undefined || n >= unsetBelow;
  return {
    kind: "number",
    defaultValue: opts.default,
    shape: {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(unit ? { unit } : {}),
      ...(integer ? { integer: true } : {}),
      ...(nullable ? { nullable: true } : {}),
    },
    read(raw) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return opts.default;
      const value = integer ? Math.floor(raw) : raw;
      return inRange(value) && isSet(value) ? value : opts.default;
    },
    validate(raw, noun) {
      if (raw === null && nullable) return ok(null);
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return fail(`${noun} must be a number${nullable ? " or null" : ""}`);
      }
      const value = integer ? Math.floor(raw) : raw;
      if (!inRange(value)) {
        const bounds = [
          min === undefined ? null : `at least ${min}`,
          max === undefined ? null : `at most ${max}`,
        ].filter(Boolean).join(" and ");
        return fail(`${noun} must be ${bounds}${unit ? ` ${unit}` : ""}`);
      }
      return ok(value);
    },
    serialize(value) {
      if (value === null || !inRange(value) || !isSet(value)) return undefined;
      return integer ? Math.floor(value) : value;
    },
  };
}

export function text(opts: {
  maxLength: number;
  default?: string;
  /** Names the value in validation messages when the dialog label does not read well. */
  noun?: string;
  required?: boolean;
  trim?: boolean;
}): SettingValueType<string> {
  const defaultValue = opts.default ?? "";
  return {
    kind: "text",
    defaultValue,
    shape: {
      maxLength: opts.maxLength,
      ...(opts.required ? { required: true } : {}),
    },
    read(raw) {
      return typeof raw === "string" ? raw : defaultValue;
    },
    validate(raw, noun) {
      const name = opts.noun ?? noun;
      // Anything that is not text reads as the default, which is how sending
      // null has always cleared an instructions box.
      const supplied = typeof raw === "string" ? raw : defaultValue;
      const value = opts.trim ? supplied.trim() : supplied;
      if (opts.required && !value) return fail(`${name} cannot be empty`);
      if (value.length > opts.maxLength) {
        return fail(`${name} is too long (max ${opts.maxLength.toLocaleString("en-US")} characters)`);
      }
      return ok(value);
    },
    serialize(value) {
      return value;
    },
  };
}

/**
 * Name and email are one setting, not two: they are written together and one
 * can land while the other throws, which is what a `partial` outcome reports
 * (plan.md → "Saved" has to mean saved).
 */
export function gitIdentity(): SettingValueType<GitIdentity> {
  const field = (max: number, noun: string) =>
    text({ maxLength: max, noun, required: true, trim: true });
  const name = field(200, "Git user name");
  const email = field(200, "Git email");
  return {
    kind: "gitIdentity",
    defaultValue: { name: "", email: "" },
    shape: { fields: { name: name.shape, email: email.shape } },
    read(raw) {
      const row = raw as Partial<GitIdentity> | null | undefined;
      return {
        name: typeof row?.name === "string" ? row.name : "",
        email: typeof row?.email === "string" ? row.email : "",
      };
    },
    validate(raw, noun) {
      if (!raw || typeof raw !== "object") return fail(`${noun} must have a name and an email`);
      const row = raw as Partial<GitIdentity>;
      const checkedName = name.validate(row.name ?? "", "Git user name");
      if (!checkedName.ok) return fail(checkedName.message);
      const checkedEmail = email.validate(row.email ?? "", "Git email");
      if (!checkedEmail.ok) return fail(checkedEmail.message);
      return ok({ name: checkedName.value, email: checkedEmail.value });
    },
    serialize(value) {
      return value;
    },
  };
}

/**
 * A pin at a catalogue entry. A retired model is kept so the resolver can follow
 * its successor instead of discarding the user's choice.
 */
export function modelSelection(): SettingValueType<ModelSelection | null> {
  const known = (selection: ModelSelection): boolean =>
    selectionExists(selection)
    || !!getMode(selection.serviceId, selection.billingMode)?.retired.some(
      (r) => r.id === selection.modelId,
    );
  const parse = (raw: unknown): ModelSelection | null => {
    const row = raw as Partial<ModelSelection> | null | undefined;
    if (!row || typeof row.serviceId !== "string" || typeof row.modelId !== "string") return null;
    if (row.billingMode !== "sub" && row.billingMode !== "key") return null;
    return { serviceId: row.serviceId, billingMode: row.billingMode, modelId: row.modelId };
  };
  return {
    kind: "modelSelection",
    defaultValue: null,
    shape: { fields: ["serviceId", "billingMode", "modelId"] },
    read(raw) {
      const selection = parse(raw);
      return selection && known(selection) ? selection : null;
    },
    validate(raw, noun) {
      if (raw === null) return ok(null);
      const selection = parse(raw);
      if (!selection) {
        return fail(`${noun} must name a serviceId, a billingMode and a modelId`);
      }
      if (!selectionExists(selection)) {
        return fail(
          `No catalogue entry for ${selection.serviceId}/${selection.billingMode}/${selection.modelId}`,
        );
      }
      return ok(selection);
    },
    serialize(value) {
      return value ?? undefined;
    },
  };
}

/**
 * A field whose every entry can be credential material — an MCP server's
 * arguments, environment or headers (`services/mcp.ts:49`, `:63`). The write is
 * refused by the type itself rather than by the declaration alone, and the
 * refusal names the field and never the value, so no output path can quote what
 * it was asked to store.
 */
export function secretBag(opts: {
  shape: "list" | "map";
  noun: string;
}): SettingValueType<unknown> {
  const empty: unknown = opts.shape === "list" ? [] : {};
  return {
    kind: "secretBag",
    defaultValue: empty,
    shape: { entries: opts.shape, values: "secret" },
    read(raw) {
      if (opts.shape === "list") return Array.isArray(raw) ? (raw as unknown[]) : [];
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    },
    validate(_raw, noun) {
      return fail(
        `${opts.noun || noun} can hold credential material, so it is edited in the panel that `
          + "owns it and never through a proposal",
      );
    },
    serialize(value) {
      return value;
    },
  };
}

/**
 * A collection is patched per item and never replaced wholesale: the agent
 * cannot see the credential fields inside an entry, so a whole-list write would
 * either drop them or echo back something it may not read (plan.md →
 * Collections are patched, never replaced).
 */
export function collection<T>(opts: {
  operations: readonly string[];
  patchableFields: readonly string[];
}): SettingValueType<readonly T[]> {
  return {
    kind: "collection",
    defaultValue: [],
    shape: { operations: opts.operations, patchableFields: opts.patchableFields },
    read(raw) {
      return Array.isArray(raw) ? (raw as T[]) : [];
    },
    validate(_raw, noun) {
      return fail(
        `${noun} is a collection: change one item at a time with `
          + `${opts.operations.join(", ")}, never by replacing the list`,
      );
    },
    serialize(value) {
      return value;
    },
  };
}
