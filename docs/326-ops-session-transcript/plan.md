---
issue: planning#674
title: Ops session — read another session's transcript (design)
description: Design for `shipit session transcript`, the ops-only read of a session's stored chat, with credential redaction and the untrusted envelope.
---

# 326 — Ops session reads a session's transcript (design)

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`.

The boundary that this feature reverses, who reversed it and why, is in
`requirements.md` ("What this reverses"). What still holds after it:

- `shipit session find` / `list --all` return metadata only.
- `shipit session logs` keeps its content-template filter. The log stream is a
  different store from the chat.
- No ops command writes to another session.
- No ops command returns another session's files, environment, queued messages
  or stored credentials.

## Shape

    shipit session transcript <session-id> [--last N] [--before N]
                              [--since T] [--until T] [--full] [--json]

The same layers as `shipit session logs` (docs/264), with the ops gate on the
route and not in the shim:

| Layer | File |
|---|---|
| Service (selection, redaction, cuts) | `orchestrator/services/host-session-transcript.ts` |
| Store reads | `orchestrator/chat-history.ts` (`listRowTimes`, `loadRowById`) |
| Credential redaction | `orchestrator/services/redaction.ts` (`redactCredentials`) |
| Route (ops gate) | `orchestrator/api-routes-host-sessions.ts` |
| Worker relay | `session/agent-ops-routes.ts` |
| Shim (flags, rendering, envelope) | `session/agent-shim/shipit-session-transcript.ts` |
| Envelope source | `shared/untrusted-input.ts` (`transcript`) |

## Decisions

### It reads the stored transcript, not a runner (req 1)

The service reads the `messages` table through `ChatHistoryManager`. It needs
no container, no worker and no runner, so a disk-evicted session and an
archived session answer the same as a live one. Archive keeps the transcript:
only `deleteSession` removes it, and a deleted session has no row to resolve
(verified at `services/session.ts:deleteSession`).

A session with no stored message gets one of two answers. `transcript_revisions`
counts every write and outlives the rows (verified at `shared/database.ts`, the
`messages_revision_*` triggers). A count above zero with no row is proof that
the messages were removed, and the output says that absence is not evidence. A
count of zero is not proof that none ever was: the count is younger than the
oldest sessions. So the output says only that there is no record.

The target id uses the same rules as `logs`: a full id or a prefix, and an
ambiguous prefix is an error (`resolveHostSessionTarget`).

A stored row that cannot be decoded, or that has the wrong shape, becomes an
entry marked `withheld`, with no content, and the messages around it are still
returned. The error quotes the stored text, so it is not passed on. For the
same reason the route's last-resort error is a fixed sentence: an error reply
is outside the redaction and outside the envelope.

### It returns the stored message, not a list of known fields (req 2)

The service returns each `PersistedMessage` whole, after redaction and cuts.
The shim prints the fields it has a form for — text, tool calls with their
results, subagent events, attachments, the flags in the header line — and
prints **every other field** as a card (an object) or as a line. A card type or
a field that is added later appears in the ops read with no change here. A list
of known card fields would silently drop the new ones, which is the failure
that req 2 forbids.

Image bytes are not text. A user image keeps only its media type. A tool result
that is stored as a JSON array of content blocks is returned as the text of its
blocks, with `[image <type>]` in place of an image (`flattenResultBlocks`):
that reads better, and the redaction patterns then see real line ends. Only an
array of exact text and image blocks is treated so. Other JSON that a tool
printed stays as it is, because an array of objects with a `type` is not always
content blocks.

### Redaction is by credential shape, on every string (req 3)

`redactCredentials` replaces:

- provider API keys, GitHub and Slack tokens and AWS keys — the same patterns
  that `redactStage1` has;
- the value after `Bearer`, `Token` or `Basic`, when it has a digit in it or is
  32 characters or longer. Stage 1 takes any 12 characters after the word, also
  "Token documentation"; in a transcript that removes ordinary prose;
- JWTs — the same matches as the Stage 1 pattern, by a pattern that is linear
  (see below);
- the password in a URL: all that is between the first `:` and the **last**
  `@` of the authority, so a password with an `@` in it leaves nothing. The
  authority ends at a character that a URL cannot hold (a quote, `<`, `\`), so
  a URL with a port in JSON does not reach into the next field;
- private key blocks: the `BEGIN` line and then key text, to the `END` line or
  to where key text ends. The marker alone, as source code quotes it, is not a
  block;
- the value of an environment-style assignment (`NAME=value`) whose upper-case
  name contains `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, `API_KEY`,
  `PRIVATE_KEY` or `ACCESS_KEY`. The value is one shell word: quoted parts and
  bare parts with no space between them, across escaped quotes and line ends,
  and to the end of the text if a quote never closes. Inside a JSON string the
  quotes are `\"`, and that form is read too. A name that ends in a word for a
  fact about the secret (`_FILE`, `_PATH`, `_DIR`, `_URL`, `_URI`, `_ID`,
  `_NAME`, `_TYPE`, `_TTL`, `_EXPIRY`, `_EXPIRES`, `_TIMEOUT`, `_LENGTH`,
  `_COUNT`, `_LIMIT`, `_ENABLED`) is not matched.

It does not touch URLs, paths, e-mail addresses or 40-character strings, so
pull request links and commit hashes stay (req 3). `redactStage1` is not
changed.

The private key, URL and assignment shapes are not in the operator's list word
for word. They are credentials, and `cat .env` or `docker inspect` in the other
session is the most probable way for one to get into a transcript.

`sanitizeDeep` passes **every string of the message** through redaction, object
keys included. No field can skip it, a new card field included. Keys that come
out as the same text get a number, so no value replaces another.

**All of a text is redacted before it is cut.** A cut through a credential
leaves a part that no pattern matches, and a credential has no maximum length.
An earlier version redacted only the kept ends and a margin, to bound the work;
the review showed a 40,000-character key block whose end came through.

Where the rules must choose, they take too much and not too little. An
assignment's value runs to the next white space, so `TOKEN=abc;git status`
loses `;git`. A quote that never closes hides the text after it.

The limit is real and the documents say so: the match is by shape. A secret in
a form that is not listed passes — `"apiKey": "…"` in JSON, `password: …` in
YAML, `api_key=…` in lower case, `--password hunter2` on a command line, a
password with an unencoded `/` in a URL.

### Redaction must not stall the orchestrator

The text is written by another session, it can be megabytes long, and the read
runs on the orchestrator's main thread, which also serves the UI.

- **Each pattern is linear.** A pattern that can start a match at each position
  of a long run, and scan the rest of the run each time, is quadratic. The
  Stage 1 JWT pattern is one: it needs 3.1 s for 80 KB of `eyJ-eyJ-…`.
  `JWT_LINEAR_RE` looks at a run of token characters once, from its start: a
  look-ahead first checks that two more dotted runs follow, and then the first
  `eyJ` after a word boundary is the match. The other patterns start only at
  the start of a run (a look-behind), or always succeed. An assignment is not
  one pattern but a scan (`redactAssignments`): one pattern finds `NAME=`, the
  name is classified once, and a sticky pattern reads the value. One pattern
  for all of it tried the name again from each later secret word when the
  value did not match, which the second review measured as quadratic.
  `redaction.test.ts` times twenty-five hostile inputs of 2 MB, and compares
  `JWT_LINEAR_RE` with the Stage 1 pattern on the cases where they could
  differ.
- **The work is bounded, for a read and for each message.** Redaction costs
  about 20 ms for each million characters. A read stops at 8,000,000 scanned
  characters (`MAX_TRANSCRIPT_SCAN_CHARS`) and names the cursor for the rest.
  In one message, a text that would pass that limit, or the response limit, is
  not read: its place says how many characters were withheld. A text is
  redacted whole or not read, because there is no safe place to stop in the
  middle of one.

Rows are loaded one at a time, newest first. A page of large rows is thus never
in memory together.

`redactStage1` keeps patterns that are quadratic (its e-mail pattern needs 9 s
for 80 KB of `a.a.a.…`). Its callers pass short text, so that is not changed
here.

### Cuts and paging (req 2)

- A text longer than 4,000 characters is cut in the middle. Three quarters of
  the limit come from its start and one quarter from its end, because the end
  of a command's output usually holds the error. The marker
  `[… ShipIt cut N characters …]` is where the cut is, and the result counts
  the cuts. `--full` raises the limit to 200,000.
- The read returns the newest 40 messages; `--last` changes that, to 400 at
  most. Each message has its 1-based position in the stored transcript, and
  `--before N` returns the messages before position N. The output names the
  value for the page before, so the whole transcript can be read.
- A page whose messages total more than 2,000,000 characters, or that passes
  the scan limit, loses its oldest messages, and the same cursor continues. The
  newest message is always returned; the same two limits then apply inside it.
  A message of very many small values, which no text limit counts, is withheld
  whole.
- A bad or empty `--last`, `--before`, `--since` or `--until` is an error. A
  default in its place would return a different page from the one that was
  asked for.

`--since` / `--until` filter on the row's `created_at`. That is the time ShipIt
**inserted** the row. A turn's rows are deleted and inserted again each time
the turn is persisted (`replaceInProgress`; `finalizeInProgress` then only
clears a flag — verified at `chat-card-persistence.ts` and `chat-history.ts`),
and a rewind inserts every row again (`saveMessages`). An in-place update of a
row, such as a card that changes state, does not move it (`UPDATE_SQL` does not
set `created_at`). So the output names the time `stored`, and the documents
send the reader to a tool call's `startedAt` or a card's `createdAt` for an
exact time.

### The text is untrusted, and it enters a privileged session

A transcript carries another session's user input, file content and web
results. An ops session can read the whole host, start a fix session and
propose a public bug report. So:

- The shim wraps everything that came from the other session — the title
  included — in the `<<UNTRUSTED SESSION TRANSCRIPT — session <id>>>` envelope.
  The lines outside it hold only values that ShipIt computed.
- Inside the envelope, text from the session is always printed deeper than the
  label that opens it, and a key or a label never spans lines. Thus a message
  cannot contain a line that looks like the header of another message or like a
  tool record. That holds for a subagent's text too. A line break that is not
  `\n`, a terminal control code and a text-direction mark are printed as
  visible text, because each can make text look as if it were somewhere else.
- `--json` cannot carry the markers, so the same statement is its first field.
- The ops system prompt (`prompts/ops-session.md`) says that a transcript is
  data, and that the agent must report text that tries to instruct it.

The envelope is framing, not a boundary (`shared/untrusted-input.ts` says the
same). What limits a steered ops agent is what an ops session can do: its host
access is read-only, a fix session ends in a pull request that a person
reviews, and a bug report needs the operator's click on its card.

### The gate (req 1, and the non-requirements)

The route is `GET /api/sessions/:id/host-session-transcript`, where `:id` is the
caller. `requireOpsSession` checks the server-side `kind === "ops"`, so an
ordinary session gets 403 for any target, its own included. The container guard
scopes on the path, so a container cannot name another caller. There is no
route with another method.

## Requirement provenance

| Statement | Source |
|---|---|
| An ops session can read the transcript of any session | The operator, 2026-10-10 |
| All that the chat shows, tool calls and results included; large bodies cut and marked | The operator's answer, 2026-10-10 (req 2) |
| Credentials only are redacted | The operator's answer, 2026-10-10 (req 3) |
| One read-only command behind the ops gate, with the id rules of `logs` | The ops agent's recommendation; taken |
| The untrusted envelope and the sentence in the ops prompt | The ops agent's recommendation; taken |
| The same redaction as the other ops reads | The ops agent's recommendation; **not** taken — the operator chose credentials only |
| `--since` / `--until` / `--lines` | The ops agent's example. The time flags are kept. `--lines` became `--last`, because the unit is messages, and `--before` and `--full` were added so that a cut or a page limit is never a dead end |
| Private key blocks, URL passwords and environment-style assignments are redacted | Derived here from "credentials" |

## Rejected

- **Make `/api/sessions/:id/history` reachable from an ops container.** That
  route serves the browser. It would need a cross-session exemption in
  `api-container-guard.ts`, which `docs/255-ops-session-inventory` req 10
  forbids, and it returns no redaction.
- **A renderer per card type.** About thirty card types exist and more are
  added. A generic print of the fields cannot fall behind them.
- **A read record in the target session.** Nobody asked for it. The command and
  its output are already in the ops session's own transcript.
- **Redact only the kept ends of a long text.** See above: it left the end of a
  long credential.

## Known limits

- The `stored` time is a row insertion time (see above).
- Redaction is by shape.
- While the target session's agent is working, the positions of its newest
  messages can move between two reads.
- An ops workspace that was seeded before this change keeps its old recipes in
  `prompts/`. `/shipit-docs/ops-session.md` says that it is the current
  contract.
