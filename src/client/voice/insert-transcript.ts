

export interface SpliceInput {

  value: string;

  selectionStart?: number;

  selectionEnd?: number;

  transcript: string;
}

export interface SpliceResult {

  value: string;

  cursor: number;
}

// Two items, so "1. It has the fix." continuing a sentence is not taken for a list.
const LIST_START = /^(?:- .+\n- |1\. .+\n2\. )/;

export function spliceTranscript(input: SpliceInput): SpliceResult {
  const { value, transcript } = input;
  const len = value.length;
  let start = input.selectionStart ?? len;
  let end = input.selectionEnd ?? start;

  start = Math.max(0, Math.min(start, len));
  end = Math.max(start, Math.min(end, len));

  const before = value.slice(0, start);
  const after = value.slice(end);

  const prevChar = before.slice(-1);
  const needsLeadingSpace = prevChar !== "" && prevChar !== " " && prevChar !== "\n" && prevChar !== "\t";
  // A list item glued to the text on either side of it is not a list item.
  const isList = LIST_START.test(transcript);
  const needsOwnLine = isList && prevChar !== "" && prevChar !== "\n";
  const insert = (needsOwnLine ? "\n" : needsLeadingSpace ? " " : "") + transcript;
  const needsLineAfter = isList && after !== "" && !after.startsWith("\n");

  return {
    value: before + insert + (needsLineAfter ? "\n" : "") + after,
    cursor: before.length + insert.length,
  };
}
