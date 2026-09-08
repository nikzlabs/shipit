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

  /** Assistant message bodies — `message-markdown.tsx`. */
  assistantMarkdown: '[data-testid="markdown-content"]',

  /** PR lifecycle card state — `PrStateBadge.tsx` puts the state in `title`. */
  prBadgeOpen: '[title^="PR #"]:not([title$="merged"]):not([title$="closed"]), [title="PR open"]',
  prBadgeMerged: '[title$="merged"]',
  /** Merge button — `PrStatusControls.tsx`, visible text per merge method. */
  mergeButtonNames: ["Squash and merge", "Create a merge commit", "Rebase and merge"],

  /** Preview iframe — `PreviewFrame.tsx`. Absent entirely in local mode. */
  previewFrame: 'iframe[title="Live Preview"]',

  /** Local-mode banner — present ⇒ no preview, no terminal (`LocalModeBanner.tsx`). */
  localModeBanner: '[data-testid="local-mode-banner"]',
};
