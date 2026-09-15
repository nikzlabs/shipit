import type { SettingsProposalDiffLine, SettingsProposalTextChange } from "../../shared/types.js";

/**
 * A prose change, shown as what it does to the text
 * (docs/299-agent-settings-access req 9).
 *
 * `from → to` chips work for a boolean, a model id or a host, and cannot work
 * for the user's own instructions: no realistic prose value fits the 200
 * characters a chip shows, so a setting declaring 50,000 read as fully
 * proposable and refused every proposal anyone would actually make.
 *
 * The refusal underneath that is not overturned — a change the user cannot check
 * by looking is still not offered as one click. What changes is that the card
 * gains a second way to show a value: a FULL-CONTEXT line diff, carrying every
 * line of both versions rather than a summary that elides part of what Apply
 * writes.
 */

/**
 * How much prose one card may carry per side.
 *
 * Deliberately lower than a declared `maxLength` of 50,000, and that is not an
 * inconsistency to reconcile: typing 50,000 characters of your own instructions
 * into the dialog is not the same act as approving 50,000 characters somebody
 * else wrote. Ten thousand is roughly 1,500 words, and past that the click stops
 * being an approval. It bounds the characters and NOT the card — see the line
 * budget below, which is what bounds the row.
 */
export const CARD_TEXT_MAX = 10_000;

/**
 * And how many lines the two versions may come to between them.
 *
 * The character bound alone does not bound the card: 10,000 single-character
 * lines a side is a 300 KB diff and 20,000 rendered rows, since a diff line
 * costs far more than the character it carries. It is a reviewability bound
 * either way — nobody checks a thousand lines before clicking — and prose at
 * `CARD_TEXT_MAX` comes to a couple of hundred.
 */
export const CARD_TEXT_LINES_MAX = 1_000;

/**
 * Past this the diff is not computed and both versions are shown whole, one
 * replacing the other. The DP below is O(n·m) over the DIFFERING middles, so the
 * cap is on cells rather than on characters; prose at `CARD_TEXT_MAX` does not
 * reach it, and a pathological value degrades to a truthful rendering rather
 * than to a refusal.
 */
const MAX_DIFF_CELLS = 1_000_000;

/**
 * Characters whose rendering differs from their content, which is
 * `unsafe_to_display` applied to the characters rather than to the length.
 *
 * Bidi overrides and isolates reorder displayed text without changing what is
 * stored, so the card would show one instruction and the button write another.
 * `Default_Ignorable_Code_Point` is Unicode's own name for what a renderer is
 * meant to show as nothing — soft hyphen, the joiners, the Hangul fillers, the
 * tag block — and is the property rather than a hand-listed range because a
 * hand-listed one missed four of them. Variation selectors are subtracted: they
 * are ignorable by that definition and are how an ordinary emoji is written.
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
// Tab, carriage return and newline are the three that are part of prose.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Ignorable, minus the variation selectors an ordinary emoji is written with. */
function hasInvisible(text: string): boolean {
  for (const [match] of text.matchAll(IGNORABLE)) {
    const code = match.codePointAt(0) ?? 0;
    if (code >= 0xfe00 && code <= 0xfe0f) continue;
    if (code >= 0xe0100 && code <= 0xe01ef) continue;
    return true;
  }
  return false;
}

/**
 * What is wrong with a value the card cannot show truthfully, or null.
 *
 * It names the class and never quotes the value: the refusal reaches the
 * transcript as tool output, and what was typed can carry a credential.
 */
export function unshowableCharacter(text: string): string | null {
  if (BIDI.test(text)) {
    return "a bidirectional override, which reorders displayed text without changing what is stored";
  }
  if (hasInvisible(text)) return "an invisible formatting character";
  if (CONTROL.test(text)) return "a control character";
  return null;
}

/** ShipIt's own one-line stand-in for prose the card carries in its diff instead. */
export function summarizeText(text: string): string {
  if (text.length === 0) return "empty";
  return `${text.length.toLocaleString("en-US")} characters`;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function tag(kind: SettingsProposalDiffLine["kind"], lines: string[]): SettingsProposalDiffLine[] {
  return lines.map((text) => ({ kind, text }));
}

/**
 * The changed middle, as removals followed by additions.
 *
 * Both versions are still whole, so the card keeps its guarantee; it just says
 * less about which parts survived. This is what the repository's own Edit view
 * renders for every file change (`DiffBlock.tsx` → `EditDiff`).
 */
function wholeMiddle(before: string[], after: string[]): SettingsProposalDiffLine[] {
  return [...tag("removed", before), ...tag("added", after)];
}

/** Longest common subsequence over the differing middles, backtracked into tagged lines. */
function diffMiddle(before: string[], after: string[]): SettingsProposalDiffLine[] {
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) return wholeMiddle(before, after);

  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = before[i] === after[j]
        ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const lines: SettingsProposalDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i] ?? "" });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      lines.push({ kind: "removed", text: before[i] ?? "" });
      i++;
    } else {
      lines.push({ kind: "added", text: after[j] ?? "" });
      j++;
    }
  }
  lines.push(...tag("removed", before.slice(i)));
  lines.push(...tag("added", after.slice(j)));
  return lines;
}

/**
 * The card's account of a prose change: every line of both versions, tagged.
 *
 * Computed HERE — on the server, at propose time, and snapshotted onto the card
 * beside `from` and `to` — because a diff is an assertion about the change and
 * so is ShipIt's to make. Computing it in the browser would let two viewers on
 * different client builds see two accounts of one approval.
 */
export function buildTextChange(before: string, after: string): SettingsProposalTextChange {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // Common prefix and suffix are trimmed first so the DP runs over the differing
  // middles only, which is what keeps an edit inside a long document cheap.
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length
    && beforeLines[head] === afterLines[head]) head++;
  let tail = 0;
  while (
    tail < beforeLines.length - head
    && tail < afterLines.length - head
    && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) tail++;

  const lines = [
    ...tag("context", beforeLines.slice(0, head)),
    ...diffMiddle(
      beforeLines.slice(head, beforeLines.length - tail),
      afterLines.slice(head, afterLines.length - tail),
    ),
    ...tag("context", beforeLines.slice(beforeLines.length - tail)),
  ];

  return {
    lines,
    before: { chars: before.length, lines: beforeLines.length },
    after: { chars: after.length, lines: afterLines.length },
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
  };
}
