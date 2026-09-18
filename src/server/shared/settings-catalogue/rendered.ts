/**
 * How anything becomes text on ONE line of the agent's settings output
 * (docs/299-agent-settings-access req 2, planning#577).
 *
 * `shipit settings list` and `get` are a line-oriented format an LLM parses:
 * `key = value` in the index, `Value: …` and `Last proposal: …` in the detail. A
 * stored string reaching one of those lines unescaped does not merely garble the
 * output — a newline inside it starts a line of its own, and that line can read
 * as one of ShipIt's own fields (`Last proposal: APPLIED by the user`, which
 * stops an agent proposing a change nobody approved) or, in `list`, as an entire
 * setting nobody declared. Not all of these strings are written by the session's
 * user: a secret name comes from the repository, and a role's description can be
 * agent-proposed from text that originated in a repository file or a web page.
 *
 * So no raw string is ever put on a line. Everything goes through one of the
 * five mints below, each of which returns {@link Rendered} — a branded string
 * the type system will not accept a plain one in place of. All five guarantee
 * the same thing: **the result contains no character that can begin a new line.**
 * They differ in how the result reads, and in one case in more than that:
 * {@link renderOwn} collapses runs of space, so composing a sentence around an
 * already-rendered value with it reports a different value from the stored one.
 * Compose with {@link renderLine} wherever a mint's output is embedded.
 *
 * The rule covers `--json` as well as the text output. `JSON.stringify` escapes
 * the C0 controls and stops there, so a document serialized for `--json` goes
 * through {@link renderJson} — a value carrying U+2028 otherwise puts a real
 * line break in the agent's stdout while `display`, beside it in the same
 * document, is correctly escaped.
 *
 * **A value is not the only thing that reaches a line, and this file is not
 * where the rule is enforced** (planning#537). Refusals, `ServiceError`
 * messages and validator output are text a service composes, and each was found
 * to be a path of its own after the one before it had been minted — so the types
 * now demand a `Rendered` at each of those hand-offs
 * (`SettingsOperation.preflight`, `RoleParamsCheck.message`,
 * `ValidationResult.message`), and the shim that PRINTS the settings output
 * accepts nothing else (`session/agent-shim/settings-out.ts`, which states
 * exactly what that does and does not close).
 */

declare const RENDERED: unique symbol;

/** Text that is safe on one line. Minted only by this file. */
export type Rendered = string & { readonly [RENDERED]: true };

/**
 * Every character that can begin a new line for some reader: the C0 and C1
 * controls (`\n`, `\r`, and NEL at U+0085), LINE SEPARATOR and PARAGRAPH
 * SEPARATOR. The format characters go with them, because a bidi override
 * reorders the rest of a line on screen without changing a byte of it.
 *
 * A deny-set rather than an allowed-shape test, because the property is narrow —
 * can this begin a line? — and an allowlist answers a wider question: what a
 * name may be made of. Each collection's own projection already answers that one
 * (`userNameProjection` and `hostEntryProjection` in `projection.ts`, with their
 * reasons), and a second shape gate here would silently drop addresses those
 * deliberately allow.
 */
const LINE_BREAKERS = String.raw`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`;
const HAS_LINE_BREAKER = new RegExp(`[${LINE_BREAKERS}]`, "u");
const EVERY_LINE_BREAKER = new RegExp(`[${LINE_BREAKERS}]`, "gu");
const RUN_OF_SPACE = new RegExp(String.raw`[\s${LINE_BREAKERS}]+`, "gu");

/**
 * Every UTF-16 code unit of the match, not just the first. The deny-set is
 * matched with the `u` flag, so a match can be one CODE POINT of two units — the
 * tag block (U+E0000…) and U+1BCA0 are format characters — and escaping the lead
 * surrogate alone leaves the trail one behind as a lone surrogate. That silently
 * changed the value a `--json` reader parses, which is the one thing this escape
 * promises not to do.
 */
function escaped(ch: string): string {
  let out = "";
  for (let i = 0; i < ch.length; i++) {
    out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}

/**
 * ShipIt's own words, on one line: a refusal sentence, a count, a literal like
 * "configured" — and an address echoed back for identification, which is the one
 * caller here that is not ShipIt's own text. Not quoted, because the reader is
 * meant to read the result as ShipIt speaking.
 *
 * It flattens rather than trusting its caller, so it is safe on anything. But it
 * is the wrong mint for a sentence that EMBEDS a rendered value: the collapse
 * reaches inside the quotes and reports a label the user never set. Compose
 * those with {@link renderLine}.
 */
export function renderOwn(text: string): Rendered {
  return text.replace(RUN_OF_SPACE, " ").trim() as Rendered;
}

/**
 * One line, kept exactly as written apart from what could break it — the mint
 * for text whose interior spacing carries meaning, and for text another process
 * already rendered.
 *
 * {@link renderOwn} collapses runs of space and trims, which is right for a
 * sentence and wrong for a line of a formatted report: it would eat the
 * indentation the agent's settings output uses to show what belongs to what.
 * This one replaces each line breaker with a space and touches nothing else, so
 * it is a no-op on text that is already single-line — which is what makes it
 * the right mint on the far side of a process boundary, where a value the
 * orchestrator rendered arrives over HTTP as a plain string with the brand
 * stripped off.
 *
 * It is not the mint for a bare stored value in a sentence: that is
 * {@link renderValue}, whose quoting says where the value starts and stops.
 * This one keeps the guarantee and not the legibility.
 */
export function renderLine(text: string): Rendered {
  return text.replace(EVERY_LINE_BREAKER, " ") as Rendered;
}

/**
 * A stored value, quoted and escaped — the mint every value-bearing output uses.
 *
 * **Every string is quoted, with no exception** (planning#577). A predicate for
 * "plain enough to leave bare" is one more thing to get wrong, and getting it
 * wrong is a hole rather than a blemish; quoting uniformly also gives the LLM
 * reading this an unambiguous grammar, and it is what separates a stored value
 * reading `not set` from ShipIt saying the setting is not set. Non-strings are
 * not quoted: `on`, `off` and a number cannot carry a line break, and an object
 * goes through `JSON.stringify`, which quotes its own strings.
 */
export function renderValue(value: unknown): Rendered {
  if (value === null || value === undefined) return "not set" as Rendered;
  if (typeof value === "boolean") return (value ? "on" : "off") as Rendered;
  if (typeof value === "number") return String(value) as Rendered;
  return renderJson(value);
}

/**
 * A whole JSON document on one line — the mint for the text a caller SERIALIZES
 * rather than the text a value formats to.
 *
 * `JSON.stringify` escapes the quote, the backslash and the C0 controls, which
 * is most of the work. It leaves U+0085, U+2028, U+2029 and the format
 * characters as themselves, so those are escaped here — U+2028 inside a quoted
 * string is still a line break to a reader that honours it, and `--json` puts
 * the whole document on one line of the agent's stdout. The escape is the JSON
 * spelling of the same character, so what a reader PARSES is unchanged: only
 * the bytes on the line differ.
 */
export function renderJson(value: unknown): Rendered {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) return "(not representable)" as Rendered;
  return json.replace(EVERY_LINE_BREAKER, escaped) as Rendered;
}

/**
 * An address the agent passes back to `--item`, so it is emitted BARE — which is
 * why it has to be a single-line token or nothing at all.
 *
 * Every collection projects its item names before they get here
 * (`userNameProjection`, `hostEntryProjection`), but not all of them: the
 * credential and provider-account collections emit ids their projection only
 * filters for being strings. Refusing here is what makes the guarantee the
 * read's rather than each declaration's, and the read already reports how many
 * instances it left unnamed.
 */
export function renderAddress(text: string): Rendered | null {
  if (text.length === 0 || HAS_LINE_BREAKER.test(text)) return null;
  return text as Rendered;
}

/**
 * Join pieces that are already rendered. The separator is fixed rather than a
 * parameter: a caller-supplied one is a raw string, and taking it would be the
 * one way to mint a `Rendered` carrying a line break.
 */
export function joinRendered(parts: readonly Rendered[]): Rendered {
  return parts.join(", ") as Rendered;
}
