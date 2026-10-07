

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

const LIST_START = /^(?:-|\d+\.) /;

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
  // A list item glued to the end of a line is not a list item.
  const needsOwnLine = LIST_START.test(transcript) && prevChar !== "" && prevChar !== "\n";
  const insert = (needsOwnLine ? "\n" : needsLeadingSpace ? " " : "") + transcript;

  return {
    value: before + insert + after,
    cursor: before.length + insert.length,
  };
}
