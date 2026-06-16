/**
 * Server → Client: the agent emitted a piece of self-contained content via the
 * `present` MCP tool (docs/093). The content lives only in the message stream —
 * no files were created in the workspace, so the user can save it explicitly
 * or dismiss it without leaving stray bytes on disk.
 *
 * If `replaceId` is set and matches a previous presentation's `presentId`, the
 * client replaces that entry in-place (revision flow); otherwise the entry is
 * appended and auto-selected.
 *
 * Metadata only — it carries NO artifact bytes. The client fetches the bytes on
 * demand from `GET /api/sessions/:id/present/:presentId/content` (a one-time
 * disk read proxied to the worker), so nothing large is retained server-side.
 */
export interface WsPresentContentMessage {
  type: "present_content";
  sessionId: string;
  /** Unique id for this presentation, returned to the agent as the tool result. */
  presentId: string;
  /** When set, replaces the entry with this id in-place. */
  replaceId?: string;
  /** "text/html", "image/svg+xml", "text/markdown", "image/png", etc. */
  mimeType: string;
  /** Optional display title (the artifact's name) for the carousel header. */
  title?: string;
  /** The path the agent presented (`present`'s `file` arg), shown in the header. */
  filePath: string;
  /** ISO8601 timestamp the worker accepted the presentation. */
  createdAt: string;
}

/**
 * Server → Client: drop one or all presentations (docs/093).
 *
 * `presentId` set → drop just that entry (a revision superseding an old id).
 * `presentId` omitted → wipe the whole list (session switch, full clear).
 */
export interface WsPresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
  presentId?: string;
}

/**
 * A single presentation entry as carried in a `present_state` replay. Metadata
 * only — the client fetches the bytes on demand (see {@link WsPresentContentMessage}).
 */
export interface PresentStateEntry {
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
  createdAt: string;
}

/**
 * Server → Client: the full current set of presentations for a session
 * (docs/093). Emitted on viewer attach so a tab that was opened after the
 * `present` tool fired — or re-opened after a session switch — hydrates from
 * the runner's authoritative cache rather than relying on the live
 * `present_content` stream it may have missed. Unlike `present_content`, this
 * does NOT bump the unseen badge or auto-switch the right panel; it's a silent
 * state sync.
 */
export interface WsPresentStateMessage {
  type: "present_state";
  sessionId: string;
  presentations: PresentStateEntry[];
}
