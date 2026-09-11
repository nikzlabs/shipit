export interface SelectionCommentData {
  id: string;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
}

export interface PendingSelection {
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  range: Range;
  blockIndex: number;
}

export interface SelectionSnapshot {
  first: DOMRect;
  last: DOMRect;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  range: Range;
  blockIndex: number;
}
