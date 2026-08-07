# Checklist — Inline issue badges for bare issue references

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

## planning#325 — recognize the docs/248 name form in prose

- [x] `ISSUE_TOKEN_RE` matches the name form (`planning#306`, `planning#57`)
      ahead of the bare key, so the whole token — not just its trailing key —
      is carried through `ISSUE_LINK_SCHEME`
- [x] Name-form lookbehind rejects a leading `/` so a GitHub short form
      (`owner/repo#42`) isn't half-matched; bare-key behaviour unchanged
- [x] `IssueBadge`'s Linear-team-prefix gate replaced with the shared
      `resolveIssueRef` over the declared destinations (docs/248 req 11) —
      undeclared and ambiguous both degrade to the original text
- [x] `toTrackerDestinations` split out of `trackerDestinations` so the badge can
      resolve from its subscribed `trackers` array without breaking the snapshot
      cache
- [x] Tests — name form with a key, name form with a number, undeclared name,
      ambiguous name, `PR#3`-shaped noise, disconnected tracker, key inside an
      autolinked tracker URL, bare key unchanged
