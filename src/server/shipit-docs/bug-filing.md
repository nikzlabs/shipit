# Filing a bug against ShipIt — the `report_shipit_bug` tool

ShipIt gives you a built-in tool, `report_shipit_bug`, for filing a bug about
**ShipIt itself** — the IDE/platform — when the user hits one and wants it
reported. It is *only* for ShipIt bugs. A bug in the user's own project is
normal work: fix it directly, don't file it upstream.

## When to use it

Offer it when the user describes a problem with ShipIt and wants it reported —
e.g. "the preview won't reload", "ShipIt keeps killing my container", "this
button is broken, file it". You compile the report; the user confirms it.

## The contract

```jsonc
report_shipit_bug({
  title: "Preview won't reload after editing a file",   // short, specific
  body:  "What happened + repro steps, in the user's words."
})
```

The tool **proposes** a report — it does **not** file anything. What happens:

1. ShipIt **redacts the body server-side** (a deterministic secret/PII scrub
   plus a best-effort semantic pass) before anyone sees it.
2. It posts an **inline consent card** in the chat with the exact redacted
   payload — an editable title and body.
3. Only when the user clicks **Submit** is a GitHub issue opened, on the public
   upstream ShipIt repo, **under the user's own GitHub identity** (the same
   token used for PRs). The result is identical to the user filing it by hand.

After the tool returns, tell the user a review card has been posted for them to
confirm. Don't claim the bug was filed — it isn't, until they submit.

## What never goes in the body

The issue is **public and attributed to the user**, so redaction is a safety
net, not a license to be careless. Never include:

- the user's email (beyond what GitHub already exposes for the author),
- their project's repo URL or name,
- secrets, OAuth tokens, or API keys,
- workspace file contents or full chat history.

Only the redacted *interaction with ShipIt* matters — the user's project is
irrelevant to a ShipIt bug.

## Credentials

There is no ShipIt-owned service credential — a self-hosted deployment is the
user's own box, so any credential it holds grants no privilege. The only
credential used is the user's own GitHub auth. If their token can't file issues
on the ShipIt repo (e.g. a fine-grained PAT scoped to their own repos), the
card surfaces a clear "reconnect with a token that can" prompt.
