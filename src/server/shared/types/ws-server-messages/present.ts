/** Metadata only; fetch bytes from /api/sessions/:id/present/:presentId/content. */
export interface WsPresentContentMessage {
  type: "present_content";
  sessionId: string;
  /** Derived from the path; re-presenting updates the same entry. */
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
  createdAt: string;
  /** The transcript card is persisted separately. */
  inline?: boolean;
}

export interface WsPresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
  /** Omit to clear all entries. */
  presentId?: string;
}

export interface PresentStateEntry {
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
  createdAt: string;
  inline?: boolean;
}

/** Full replay on viewer attach; does not mark unseen or switch panels. */
export interface WsPresentStateMessage {
  type: "present_state";
  sessionId: string;
  presentations: PresentStateEntry[];
}
