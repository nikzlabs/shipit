import { joinRendered, renderOwn, renderValue, type Rendered } from "./rendered.js";
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
    case "user_name":
      return { readable: true, value: userNameProjection(raw) };
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

/**
 * One line of text for a read, and the one mint of it.
 *
 * Takes the outcome, never the declaration's stored value: a formatter handed
 * the raw value is exactly how a projection gets bypassed in the one output
 * path nobody re-checks.
 *
 * The result is {@link Rendered} rather than a string, which is what carries the
 * rule past this file (planning#577): the fields that carry a VALUE into the
 * agent's line-oriented output are declared as that type, so shortening one
 * afterwards, or formatting a stored value some other way, is a type error
 * rather than the one line nobody re-checks. It does not govern the fields that
 * carry ShipIt's own prose — a note, an effect's detail, a refusal sentence —
 * which are literals in this repository and stay plain strings.
 */
export function formatSetting(
  declaration: AnySettingDeclaration,
  outcome: ProjectionOutcome,
): Rendered {
  if (!outcome.readable) return renderOwn(outcome.explanation);
  if (declaration.emits.kind === "configured_only") {
    return renderOwn(
      (outcome.value as { configured: boolean }).configured ? "configured" : "not configured",
    );
  }
  if (Array.isArray(outcome.value)) {
    return outcome.value.length === 0
      ? renderOwn("empty")
      : joinRendered(outcome.value.map(renderValue));
  }
  return renderValue(outcome.value);
}

/**
 * A name the user chose, emitted only when it is shaped like a name.
 *
 * Naming a role, an MCP server or a missing secret is the whole of what the
 * agent has to tell the user, so these names are emitted deliberately — but
 * nothing constrains what they are made of. `PUT /api/secrets` takes any string
 * as a key (`api-routes-secrets.ts:46`) and a role name is only checked for
 * being non-blank and short enough (`services/role-settings.ts:200`), so
 * `https://user:token@host/path?token=…` is a storable name, and an item's
 * ADDRESS is where it leaves (`settings-read.ts` → `itemAddress`).
 *
 * This is the same judgement {@link hostEntryProjection} and
 * {@link mcpUrlProjection} already make: a URL carries a credential in its
 * userinfo and its query as a matter of routine, so a name wearing that shape is
 * named by nothing rather than repeated back. A name that fails here produces no
 * item at all and the read reports how many it left out.
 *
 * **What it does NOT do is decide whether a name is itself a secret**, and it
 * cannot: `Bearer ghp_…` typed into the name box passes, because nothing
 * separates it from a name someone meant. That is the deny-list the design
 * already rejected — "a token lives in a field called `args`", and the answer
 * there was an allowlist of derived values, not a scanner. Emitting the name is
 * the user's own decision (`requirements.md`, resolved 2026-09-13: secret NAMES
 * are in scope, secret values are not), the dialog and every service already
 * show it, and the `user_name` mark is what says a human chose that. What this
 * gate adds is that the one shape which carries a credential *without* anyone
 * choosing to — a URL pasted into a name box — is not repeated back.
 *
 * Deliberately permissive about what a name may CONTAIN — letters, digits,
 * spaces and the punctuation names actually use — because the point is to emit
 * the user's own words. What it excludes is URL-shaped punctuation
 * (`:` `/` `@` `?` `#` `%` `&` `=`) and a length no name has.
 *
 * **Emitted VERBATIM, never normalized.** The name is the ADDRESS a change
 * names, and the stores behind one look an item up exactly (`getRole` reads
 * `roles[name]`; a secret is a record key) while neither write path normalizes.
 * Trimming would advertise an address resolving to a different item or to none,
 * and `" helper "` beside `"helper"` would emit one address twice. A padded name
 * is named by nothing for the same reason, one step further on: `--item` is
 * trimmed before it is resolved (`services/settings-propose.ts:169`), so an
 * address with an edge space could not be proposed back whatever it emitted.
 */
const NAME_MAX = 200;
const USER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+()[\]-]*$/u;

export function userNameProjection(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > NAME_MAX) return null;
  // The regex admits a trailing space; `--item` is trimmed, so it could not come back.
  if (raw !== raw.trim()) return null;
  return USER_NAME.test(raw) ? raw : null;
}

/**
 * A collection of items the user names — roles, MCP servers. Each entry is
 * either the name itself or an object carrying one, and each goes through
 * {@link userNameProjection}, so an item the gate refuses is named by nothing
 * and `settings-read.ts` produces no item for it.
 */
export function userNamesProjection(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry : (entry as { name?: unknown })?.name))
    .map(userNameProjection)
    .filter((name): name is string => name !== null);
}

/**
 * An allowlist entry, but only when it is shaped like a host — a leading dot
 * for a subdomain match, then labels.
 *
 * `normalizeHost` trims, lowercases and drops a trailing dot and nothing else
 * (`egress-allowlist.ts:88`), and the dialog stores whatever was typed, so a
 * pasted `https://user:token@host/path?token=…` is a possible stored entry. Such
 * an entry matches no host — `hostMatchesEntry` compares whole labels — so
 * emitting nothing for it loses the reader nothing and keeps a pasted credential
 * out of every output.
 *
 * Unlike {@link userNameProjection} this one may normalize, because the store
 * normalizes identically: `EgressAllowlistStore` puts every entry through
 * `normalizeHost` on the way in and on the way to a match, so an emitted entry
 * is the stored row and addresses it back.
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
