# Checklist — Inline issue badges for bare Linear keys

- [x] `remarkLinkifyIssues` plugin wrapping key-shaped tokens in
      `shipit-issue:KEY` link nodes (`linkify-issues.ts`)
- [x] `urlTransform` passthrough so react-markdown keeps the sentinel scheme
- [x] `IssueBadge` component with the team-key gate (connected Linear + bound
      `binding.key`) and plain-text fallback
- [x] `MarkdownLink` badge branch + shared `openIssueInPanel` (mobile panel
      switch shared with the issue-URL branch)
- [x] Plugin added to the shared `remarkPlugins` chain
- [x] Unit test (`linkify-issues.test.ts`) — match, multi, inline-code, fenced
      skip, existing-link skip, lowercase/mid-token rejection
- [x] Committed line-height mockup (`mockup.html`)
- [x] typecheck + lint clean
