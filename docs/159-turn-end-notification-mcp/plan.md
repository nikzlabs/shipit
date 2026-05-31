---
status: done
priority: low
description: Recipe for connecting ShipIt agents to a personal external MCP server that delivers a voice-ready end-of-turn summary. Configuration-only on the ShipIt side.
---

# Personal end-of-turn notification MCP

## What this gets you

At the end of every ShipIt agent turn, the agent calls one tool on an external MCP server you host. That server decides how to notify you — voice message, push, Slack, anything. The notification reads naturally because the agent shapes the summary specifically for spoken delivery, not as a status dump.

This doc uses `notify` as a placeholder name for the receiver. Substitute whatever lowercase alphanumeric name you choose for your MCP server. ShipIt exposes MCP tools through the standard `mcp__<server-name>__<tool-name>` namespace, so a server named `notify` exposes the tool as `mcp__notify__notify_turn_end`.

## What you'll do

Three things, in order:

1. **Stand up the receiver** — an HTTP MCP server you host, reachable from your ShipIt host (Tailscale, VPN, or public + auth).
2. **Add the receiver to ShipIt** in Settings → MCP Servers, so the agent has the tool in its catalog.
3. **Add an instructions block** in ShipIt Settings → Your Instructions, so the agent actually calls the tool at every turn end.

If you've never done this: an evening, mostly on the receiver. The two ShipIt-side steps are five minutes each.

## Step 1 — stand up the receiver

The receiver is a small HTTP MCP server. Easiest path: paste the [Receiver bootstrap prompt](#receiver-bootstrap-prompt) at the bottom of this doc into an agent (Claude, Codex, your existing assistant) and let it write the server. The contract it must satisfy is below — keep this as the spec to verify against.

### Transport

HTTP MCP, Streamable HTTP transport per the MCP spec. Listen on a path of your choice; you'll paste the full URL into ShipIt in Step 2.

### Auth

`Authorization: Bearer <token>` on every request, constant-time compare, 401 on mismatch. Generate a token with `openssl rand -hex 32`; the same value goes into ShipIt in Step 2.

### Tool

Expose exactly one MCP tool:

```json
{
  "name": "notify_turn_end",
  "description": "Notify the user that a ShipIt agent turn has ended. Called once at the end of every turn. voiceSummary is read aloud.",
  "inputSchema": {
    "type": "object",
    "required": ["voiceSummary", "needsAttention"],
    "properties": {
      "voiceSummary":   { "type": "string" },
      "needsAttention": { "type": "boolean" },
      "context": {
        "type": "object",
        "description": "Display-only metadata. Not voiced verbatim; prTitle/sessionName may seed a voice intro.",
        "properties": {
          "repo":        { "type": "string" },
          "prUrl":       { "type": "string" },
          "prTitle":     { "type": "string" },
          "sessionName": { "type": "string" }
        }
      }
    }
  }
}
```

Ignore unknown context fields (older clients may still send `branch` — drop it silently).

### Behavior

On every `notify_turn_end` call:

- **Route by `needsAttention`.** `true` → attention-grabbing channel (voice call, push with sound). `false` → low-friction channel (silent push, queued TTS).
- **Text channels (Telegram, Slack, etc.):** body is `voiceSummary`. If both `context.prTitle` and `context.prUrl` are present, render one clickable link using `prTitle` as the visible label and `prUrl` as the target. Don't also show the raw URL.
- **Voice channels (TTS, voice call):** speak `voiceSummary` verbatim — the agent already shaped it for voice. Prepend a short intro from `context.prTitle` if present, else `context.sessionName` if present, else no intro. Format naturally so intro + summary read as one sentence: `"About <prTitle>: <voiceSummary>"`. Never speak `prUrl`, `repo`, or other context fields.
- **Return value.** A short success string telling the agent which channel was used (e.g. `"Sent via voice."`). Appears in the transcript; useful for debugging.

Optional but recommended: log every call (timestamp, summary, needsAttention, context, channel, outcome) so you can answer "why didn't I get notified about X."

## Step 2 — add the server to ShipIt

Settings → MCP Servers → **"+ Add MCP Server"**:

| Field | Value |
|---|---|
| Name | `notify` — lowercase alphanumeric (any name; the agent will see the tool as `mcp__<name>__notify_turn_end`). |
| Type | `http (remote endpoint)` |
| URL | `https://notify.<your-tailnet>.ts.net/mcp` (whatever URL the receiver exposes) |
| Headers (click "+ Add header") | Key: `Authorization` &nbsp;&nbsp; Value: `Bearer <token>` |

Click **Save**. The server is account-level — available in every session and every repo. The bearer token is stored in the credentials volume; ShipIt never echoes it back to the UI.

Tailscale `*.ts.net` hostnames work from inside ShipIt session containers without extra config — containers inherit the host's network stack and MagicDNS.

## Step 3 — tell the agent to call it

Settings → Instructions → **"Your Instructions"**. Append the block below. Replace `notify` (the example server name) with the name you used in Step 2.

```text
## End-of-turn notification

Call `mcp__notify__notify_turn_end` exactly once at the end of every turn, before
you stop producing output. This is how the user gets notified you've
finished — don't skip it. If the tool fails, try once and mention it in your
final reply.

Args:
- `voiceSummary` (required string): one or two natural-English sentences
  written for SPOKEN delivery. No markdown, no code, no file paths, no commit
  hashes, no PR numbers. When there's no PR, make the summary self-
  identifying — lead with a noun phrase about what you worked on so the user
  knows the topic from the voice alone.
    GOOD: "Done — added the post-turn webhook and pushed it up."
    GOOD: "Stuck on a type error in the settings panel — mind taking a look?"
    BAD : "Updated agent-execution.ts:451, ran typecheck ✓"
- `needsAttention` (required boolean): true when blocked on the user
  (question, error, decision needed). False when they can read the diff at
  leisure.
- `context` (optional): display-only metadata, not voiced verbatim. Include
  `repo`, `prUrl`, `prTitle` when known — `prTitle` is high-value (becomes
  the link label in text channels and the voice intro). If a PR exists and
  you don't already know its title+URL, run `gh pr view --json url,title`
  once. Leave `sessionName` unset (reserved).

Example:
  mcp__notify__notify_turn_end({
    voiceSummary: "Done — added the webhook and pushed it up.",
    needsAttention: false,
    context: {
      repo: "shipit",
      prUrl: "https://github.com/owner/repo/pull/123",
      prTitle: "Add post-turn webhook"
    }
  })
```

The tool name follows the MCP namespace convention used by ShipIt agents: `mcp__<server-name>__<tool-name>`. The middle segment must match the Name from Step 2. For example, if the server is named `hermes`, the turn-end tool is `mcp__hermes__notify_turn_end`.

## Step 4 — verify

Start a fresh session, give the agent any small task (`"rename this variable"` works). At end of turn:

1. The `notify_turn_end` call should appear in the chat transcript.
2. You should get the notification on your delivery channel.

Common gotchas:

| Symptom | Likely cause |
|---|---|
| No tool call in transcript | Instructions block isn't being applied — check Settings → Instructions is saved, and the "ShipIt Agent Instructions" toggle is on. |
| Tool call happens, no notification | Receiver-side issue — check its logs. |
| Tool call returns auth error | Bearer token in ShipIt Settings doesn't match the receiver's expected token. |
| Notification arrives but with the branch slug instead of PR title | Agent isn't including `prTitle` in `context`. Most often happens on the first turn after PR creation if it forgets — usually self-corrects on the next turn. |

## Receiver bootstrap prompt

Paste this into your agent of choice to get the receiver built end-to-end:

```text
Build an MCP server that ShipIt agents will call at the end of every turn to
notify me. Personal use — no multi-tenancy, no fancy auth flows.

## Transport and endpoint

HTTP MCP server, Streamable HTTP transport per the MCP spec. Pick the path
yourself — I'll paste the full URL into ShipIt. Reachable over my Tailscale
network (you're already on the tailnet). Listen on a non-privileged port.

## Auth

`Authorization: Bearer <token>` required on every request. Constant-time
compare. 401 on mismatch. Store the expected token in your existing secret
store — do not hardcode it. Generate a 32-byte hex token
(`openssl rand -hex 32`) on first start if one isn't configured, and print
it to your logs so I can copy it into ShipIt.

## Tool: notify_turn_end

Expose exactly one MCP tool:

  name: notify_turn_end
  description: "Notify the user that a ShipIt agent turn has ended. Called
                once at the end of every turn. voiceSummary is read aloud."
  inputSchema:
    type: object
    required: [voiceSummary, needsAttention]
    properties:
      voiceSummary:   { type: string }
      needsAttention: { type: boolean }
      context:
        type: object
        description: "Display-only metadata. Voice channels never speak
                      these values verbatim; prTitle/sessionName may seed
                      a voice intro per the rules below."
        properties:
          repo:        { type: string }
          prUrl:       { type: string }
          prTitle:     { type: string }
          sessionName: { type: string }

Ignore unknown context fields (e.g. `branch` from older client instructions).

## Behavior

1. Validate the bearer token. Validate the input shape; return an MCP tool
   error if invalid (the agent will see the error and can correct itself).

2. Route by needsAttention:
     - true  → attention-grabbing channel (voice call, push with sound).
     - false → low-friction channel (silent push, queued TTS).
   Pick the specific channel based on time of day and my recent activity.

3. TEXT CHANNELS (Telegram, Slack, etc.):
     - Body is `voiceSummary` verbatim.
     - If BOTH `context.prTitle` and `context.prUrl` are present, render a
       single clickable link using `prTitle` as the visible label and
       `prUrl` as the target. Do NOT also show the raw URL.
     - If only `prUrl` is present, the bare URL is fine.

4. VOICE CHANNELS (TTS, voice call):
     - Speak `voiceSummary` VERBATIM. Do not paraphrase or rewrite — the
       ShipIt agent already shaped it for spoken delivery.
     - PREPEND a short voice intro derived from:
         a. context.prTitle if present
         b. else context.sessionName if present
         c. else no intro at all
       Format the intro so intro + summary read as one fluent sentence,
       e.g. "About <prTitle>: <voiceSummary>".
     - NEVER speak `prUrl`, `repo`, or any other context field.

5. Return a short success string telling the agent which channel was used
   (e.g. "Sent via voice." or "Queued for silent push."). Shows up in the
   agent's transcript; useful for debugging delivery.

## Logging

Log every call: timestamp, voiceSummary, needsAttention, context, chosen
channel, delivery outcome. Append-only file or SQLite. I'll want this when
something didn't notify me the way I expected.

## What to deliver back to me

1. The exact URL I should paste into ShipIt's MCP config (scheme, host,
   port, path).
2. The bearer token (or that you generated one and it's in your logs).
3. Which channels you'll use for needsAttention=true vs false, given my
   current setup.
4. A sample voiced sentence given a prTitle, so I can hear whether the
   intro flows naturally.
5. A sample text-channel render showing the prTitle-labeled link.

After confirmation I'll add the ShipIt-side config and we'll do a real
end-to-end test.
```

When the receiver is up, come back to Step 2 with the URL and bearer token in hand.
