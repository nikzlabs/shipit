// Every selector the demo driver touches, in one place — docs/296 plan §4.
//
// A UI rename is one edit here. Prefer `data-testid` where the client has one;
// the rest are aria-labels and visible text, with the source file named so the
// next reader can check the markup. Playwright locator syntax throughout.

export const SELECTORS = {
  /** Composer textarea — `MessageInput.tsx` (`data-chat-input`, no testid). */
  composerInput: "textarea[data-chat-input]",
  /** Placeholder the textarea shows only when the chat can run a turn. */
  composerReadyPlaceholder: "Describe what to build... (type @ to attach files)",
  /** Send button — mounted only while no turn runs (unless live steering). */
  sendButton: '[data-testid="send-button"]',
  /** Stop button — mounted only while a turn runs. */
  stopButton: '[data-testid="stop-button"]',
  /** Inline trust gate above the composer — `RepoTrustNotice.tsx`. */
  trustNotice: '[data-testid="repo-trust-notice"]',
  trustAccept: '[data-testid="repo-trust-notice-accept"]',

  /** Sidebar collapse — `SessionSidebar.tsx`, aria-labels. */
  sidebarCollapse: 'button[aria-label="Collapse sidebar"]',
  sidebarExpand: 'button[aria-label="Expand sidebar"]',
  /** Repo group header — `SessionGroup.tsx`; `${state} ${repoName}`. */
  repoGroupHeader: (repoName, state) => `button[aria-label="${state} ${repoName}"]`,
  /** The group's session list, a sibling subtree of the header. */
  repoGroupList: '[data-testid="group-session-list"]',
  /** "New session" row inside a repo group — visible text, no testid. */
  newSessionRowText: "New session",

  /** Right-pane tabs — `ui/tab.tsx`: `<button aria-label={label}>`, no role=tab. */
  paneTab: (label) => `button[aria-label="${label}"]`,
  /** Storyboard pane name → tab label. `transcript` and `pr-card` are the chat pane (always visible). */
  paneTabLabels: { preview: "Preview", files: "Files" },

  /** File tree entry — `FileTree.tsx`: `<button title={node.path}>`. */
  fileTreeEntry: (name) => `button[title="${name}"], button[title$="/${name}"]`,
  fileTreeRefresh: 'button[title="Refresh file tree"]',

  /**
   * The transcript's scroll container — `MessageList.tsx`, the one
   * `overflow-y-auto` child of the chat pane's `isolate` wrapper (`App.tsx`,
   * the only element with that class outside the mobile voice overlay; a
   * sibling of the PR card header below). No testid of its own.
   */
  transcript: "div.isolate > div.overflow-y-auto",
  /**
   * One assistant message group — `TranscriptRow.tsx`: the assistant bubble is
   * `div.group.justify-start > div` with `MarkdownContent` as a direct child
   * (`message-markdown.tsx`, `data-testid="markdown-content"`). User bubbles
   * are `justify-end` and not markdown; transcript cards (`MessageCards.tsx`)
   * wrap in `flex justify-start` without `group`, and their markdown (a PR body)
   * is nested deeper, so neither matches.
   */
  assistantMessage: 'div.group.justify-start > div > [data-testid="markdown-content"]',

  /**
   * The active session's PR card header — `PrLifecycleCard.tsx`, the bar above
   * the transcript, identified by its "Search conversation" button (nowhere
   * else in the client). Scoping to it matters: the sidebar's `SessionItem.tsx`
   * renders the same `PrStateBadge` for every session.
   */
  prCardHeader: 'div:has(> div > button[aria-label="Search conversation"])',
  /** The card's actions row (status chips + merge controls), the header's next sibling. */
  prCardActions: 'div:has(> div > button[aria-label="Search conversation"]) + div',
  /** PR lifecycle card state — `PrStateBadge.tsx` puts the state in `title`; scoped to the header above. */
  prBadgeOpen:
    'div:has(> div > button[aria-label="Search conversation"]) [title^="PR #"]:not([title$="merged"]):not([title$="closed"]), ' +
    'div:has(> div > button[aria-label="Search conversation"]) [title="PR open"]',
  prBadgeMerged: 'div:has(> div > button[aria-label="Search conversation"]) [title$="merged"]',
  /** Merge button — `PrStatusControls.tsx`, visible text per merge method; found inside `prCardActions`. */
  mergeButtonNames: ["Squash and merge", "Create a merge commit", "Rebase and merge"],

  /** Preview iframe — `PreviewFrame.tsx`. Absent entirely in local mode. */
  previewFrame: 'iframe[title="Live Preview"]',

  /** Local-mode banner — present ⇒ no preview, no terminal (`LocalModeBanner.tsx`). */
  localModeBanner: '[data-testid="local-mode-banner"]',
};
