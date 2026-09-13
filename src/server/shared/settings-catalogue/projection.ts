import type {
  AnySettingDeclaration,
  Projection,
  RefusalReason,
} from "./types.js";

/**
 * What a declaration is allowed to say about its value, and how that reads as
 * one line (docs/299-agent-settings-access req 2, plan.md → `emits` is an
 * allowlist of derived values).
 *
 * **Every output path starts here.** The stored value never reaches a reader:
 * `projectSetting` is what produces the emitted value, and `formatSetting`
 * takes that outcome rather than the raw value, so a formatter cannot be the
 * one place a token escapes.
 */

export type ProjectionOutcome =
  | { readonly readable: true; readonly value: unknown }
  | { readonly readable: false; readonly reason: RefusalReason; readonly explanation: string };

const REFUSAL_SENTENCES: Record<RefusalReason, string> = {
  secret: "This holds credential material, so ShipIt reports only whether it is configured.",
  external_flow:
    "This is connected through a sign-in on the provider's own site, which ShipIt cannot do for you.",
  browser_local:
    "Set in the browser; ShipIt's server does not hold this value.",
  unsafe_to_display:
    "A proposal card could not show the full effect of this change, so it is not offered.",
};

/** The sentence `list`, `get` and a refused propose all say. */
export function refusalSentence(reason: RefusalReason): string {
  return REFUSAL_SENTENCES[reason];
}

/** "Configured" is the whole of what a secret-bearing value may say. */
function isConfigured(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === false) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "object") return Object.keys(raw).length > 0;
  return true;
}

function applyProjection(emits: Projection, raw: unknown): ProjectionOutcome {
  switch (emits.kind) {
    case "plain":
    case "user_text":
      return { readable: true, value: raw ?? null };
    case "configured_only":
      return { readable: true, value: { configured: isConfigured(raw) } };
    case "derived":
      return { readable: true, value: emits.project(raw) ?? null };
    case "withheld":
      return { readable: false, reason: emits.reason, explanation: refusalSentence(emits.reason) };
  }
}

/**
 * The emitted value for one setting. `raw` is the stored value — for an
 * item-addressed declaration, the one field of the one item, not the item.
 */
export function projectSetting(
  declaration: AnySettingDeclaration,
  raw: unknown,
): ProjectionOutcome {
  return applyProjection(declaration.emits, raw);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return value.length > 0 ? value : "empty";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * One line of text for a read.
 *
 * Takes the outcome, never the declaration's stored value: a formatter handed
 * the raw value is exactly how a projection gets bypassed in the one output
 * path nobody re-checks.
 */
export function formatSetting(declaration: AnySettingDeclaration, outcome: ProjectionOutcome): string {
  if (!outcome.readable) return outcome.explanation;
  if (declaration.emits.kind === "configured_only") {
    return (outcome.value as { configured: boolean }).configured ? "configured" : "not configured";
  }
  if (Array.isArray(outcome.value)) {
    return outcome.value.length === 0 ? "empty" : outcome.value.map(formatScalar).join(", ");
  }
  return formatScalar(outcome.value);
}

/**
 * An allowlist entry, but only when it is shaped like a host — a leading dot
 * for a subdomain match, then labels.
 *
 * `normalizeHost` trims, lowercases and drops a trailing dot and nothing else
 * (`egress-allowlist.ts:82`), and the dialog stores whatever was typed, so a
 * pasted `https://user:token@host/path?token=…` is a possible stored entry. Such
 * an entry matches no host — `hostMatchesEntry` compares whole labels — so
 * emitting nothing for it loses the reader nothing and keeps a pasted credential
 * out of every output.
 */
const HOST_ENTRY = /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function hostEntryProjection(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const entry = raw.trim().toLowerCase();
  return HOST_ENTRY.test(entry) ? entry : null;
}

/**
 * The host an MCP URL is reachable at, and nothing else of it: userinfo, path,
 * query and fragment are where a token travels (plan.md's worked pair refuses a
 * URL change for the same reason).
 */
export function mcpUrlProjection(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return { scheme: url.protocol.replace(":", ""), host: url.host };
  } catch {
    // An unparseable URL is still a string the user typed, so it says nothing.
    return { scheme: null, host: null };
  }
}
