---
issue: planning#419
title: Installer checkbox prompts — design
description: How the VPS installer's arrow-key checklist works, and why it is bash rather than a TUI library
---

# Installer checkbox prompts

Implements [requirements.md](./requirements.md).

The VPS installer's two multiple-choice questions become a keyboard-driven
checklist: arrow keys move, the space bar toggles, Enter confirms (reqs 1–3).

```
Access setup — how do you want to reach ShipIt from your browser?
  …
  [up/down] move    [space] select    [enter] confirm

  > [ ] Cloudflare Tunnel  public HTTPS domain, Zero Trust protected
    [*] Tailscale          private, reachable from your tailnet only
```

## Why bash, and not a library

The prompt is drawn by ~130 lines of bash and ANSI escapes with no dependency at
all — not `whiptail`, not `dialog`, not `gum`, not a Node prompt library. That is
a consequence of *when* the question is asked, not a preference:

`sudo bash -c "$(curl … setup.sh)"` runs the script on a **bare Ubuntu box**, and
the access question is the **first thing** it does — before `apt-get`, before
Docker, before git, before the repo is cloned (req 10). Any library has to be
fetched before it can draw anything:

- **`whiptail` / `dialog`** — usually present on Ubuntu Server, *not* guaranteed
  on minimal cloud and container images, so it needs an `apt-get install` before
  the first question. That reorders the install (packages before questions) and
  still leaves a fallback path to write for when the package can't be had. It
  also draws a full-screen blue ncurses dialog, which clears the operator's
  scrollback in the middle of an otherwise plain-text install log.
- **`gum` / `fzf`** — a binary downloaded from a third party, with architecture
  detection, at the very start of a security-conscious installer. A new
  supply-chain dependency for a checkbox is a bad trade.
- **A Node/TS prompt library** — Node is not on the box. Installing a runtime in
  order to ask which harnesses to install inverts the script's whole job.

So the dependency-free version is not the cheap option here; it is the only one
that keeps the question where it belongs. The cost is bounded: the picker is a
self-contained block, and it is driven under a real pty by a test.

## The picker

`deployment/vps/setup.sh`, between the `# --- BEGIN shipit-picker` and
`# --- END shipit-picker` markers.

```bash
shipit_pick "<preselected,csv>" "key|Label|one-line hint" ...
# -> SHIPIT_PICK_RESULT holds the chosen keys, comma-separated ("" when none)
```

- **Four functions.** `shipit_pick` (setup + read loop), `shipit_pick_key` (the
  key map, split out so it is exercisable without a terminal),
  `shipit_pick_render` (one line per row, redrawn in place with `\033[<n>A`), and
  `shipit_pick_restore` (un-hides the cursor, from the normal path **and** from
  the `INT` trap).
- **Nothing hand-sets echo, and that is load-bearing.** The obvious `stty -echo`
  around the read loop with a restore in the trap is wrong in a way that only
  shows up on Ctrl-C: `read` saves the terminal state as it finds it — by then
  already `-echo` — and re-applies that state when an interrupt tears it down,
  *after* the trap has restored it. The operator is left typing blind in their
  own shell long after the installer is gone. The first version of this feature
  had exactly that bug; it was caught in review and reproduced under a pty.
  `read -s` on both reads suppresses echo for the window that matters and leaves
  the saved state echoing, which is what makes Ctrl-C safe — and it drops the
  last external command, so "no dependency" is literal.
- **Keys**: `↑`/`↓` and `j`/`k` move and wrap, space toggles, Enter confirms.
  Both `\e[A`-style and application-cursor-mode `\eOA` arrows are accepted, since
  terminals switch between them. `read -n1` strips the newline, so Enter arrives
  as the empty string.
- **Drawn on the terminal, not on stdout.** `sudo bash setup.sh | tee install.log`
  is a normal way to run an installer, and the typed prompts this replaced stayed
  usable under it (`read -p` prompts on stderr and reads stdin). So the loop's
  output is redirected to `/dev/tty` whenever stdout is not a terminal. Giving up
  there instead — the first implementation — silently skipped a question the
  operator was waiting to answer.
- **No terminal, no prompt.** `shipit_pick` returns non-zero *without reading*
  when stdin is not a TTY, or when stdout is redirected and `/dev/tty` cannot be
  opened either, leaving the caller's preselection in `SHIPIT_PICK_RESULT`
  (req 8). Callers must branch on that **return code, never on the answer**: the
  preselection is byte-identical to an operator ticking exactly those boxes, and
  `resolve_harnesses` treating one as the other would record a default it never
  asked about as a deliberate choice — persisting it, and so clobbering a
  narrower earlier choice on the next run. Every caller also gates its
  explanatory prose on `[ -t 0 ]`, so a piped install prints nothing about a
  question it never asked.
- **Self-contained on purpose.** It cannot call a helper from outside the
  markers, because there is no library file to source at the moment it runs — the
  script is executing as a string piped from `curl`. The test extracts the block
  between the markers rather than duplicating it.

## Callers

| Question | Options | Preselected | Pre-answer |
|---|---|---|---|
| Access setup | `cloudflare`, `tailscale` | `tailscale` | `SHIPIT_ACCESS` |
| Agent harnesses | every known harness | the approved set | `SHIPIT_HARNESSES` |

## Defaults (reqs 6, 7)

**Tailscale, alone, for access.** It reaches your own devices and nothing else,
with no domain to own and no public URL to protect. Cloudflare is the deliberate
choice, because a public hostname is the bigger commitment.

**Claude Code, Codex and OpenCode for harnesses — an approved set, not a derived
one.** Two questions that look like one, and the whole point of req 7 is that
they have different answers:

| Question | Source of truth | Pinned to the catalogue? |
|---|---|---|
| Which harnesses may I *have*? | `KNOWN_HARNESSES` (build), `HARNESS_ROWS` (installer) | **Yes** — a harness in `HARNESSES` and nowhere else fails the build |
| Which do I get by *default*? | `DEFAULT_HARNESSES` (build), `HARNESS_DEFAULT` (installer) | **No** — hand-maintained on purpose |

So integrating a harness makes it installable and visible in the picker
immediately, sitting **unchecked**. Turning it on for everyone who accepts the
defaults ships a new agent CLI to every install, which is a product decision, so
it takes a deliberate edit to the two `*_DEFAULT*` lines. An earlier revision of
this branch derived the default from the known set; that made "add a harness"
and "ship it to everybody" the same commit, which is what req 7 rules out.

`agent-cli-install.test.ts` guards all four lists: the two "may have" ones must
equal the catalogue, the two default ones must equal each other, and the default
set may only name real harnesses (so a typo or a leftover id fails here rather
than in a much later image build).

Why the build's default matters as much as the picker's: an **unanswered**
question deliberately persists nothing (see `resolve_harnesses`), so
`DEFAULT_HARNESSES` is what a `curl | bash` or local install actually gets. Every
Dockerfile declares `ARG SHIPIT_HARNESSES=` (empty) and compose passes
`${SHIPIT_HARNESSES:-}` through, so that one line is the only place the answer
lives.

Adding OpenCode to the set reverses docs/268 req 3, which kept it out while it
was new. That doc records the supersession.

**Access** was a 1/2/3/4 menu whose items 3 and 4 were "both" and "none". Since
Cloudflare and Tailscale are independent, they are now two checkboxes and those
two items disappear as *emergent* states: tick both, or tick neither (req 4).
`INSTALL_CLOUDFLARE` / `INSTALL_TAILSCALE` are derived from the answer, so
everything downstream is untouched (req 5). `SHIPIT_ACCESS` is new — it is the
counterpart of `SHIPIT_HARNESSES` and gives the non-interactive path a way to say
something other than the default, which the old typed prompt never had.

The no-terminal access path is also a fix rather than a preservation — see
requirements.md req 8 for what the old unconditional `read` did under
`curl | bash`.

**Harnesses** was a typed comma-separated list. The picker cannot produce an
invalid answer, so the `harnesses_valid` check now guards the one input that is
still untrusted — a scripted `SHIPIT_HARNESSES` — and fails at the question
rather than many minutes later inside the image build. An empty selection falls
back to the approved default set with a message, because an image with no
harness does not build.

Both validators normalize (strip whitespace, lowercase) **before** checking, and
count recognized entries rather than testing the raw string. That is not
tidiness: `docker/agent-cli/install-agent-clis.sh` does the same normalization
before its own check, so a stricter test here would reject
`SHIPIT_HARNESSES="Claude,Codex"` installs that work today — and a laxer one
would let `","`, which names nothing, through to fail in the build.

The egress-containment question is deliberately left as a typed `[y/N]`: it
confirms a security downgrade rather than choosing among options, and a
preselected checkbox is the wrong shape for that.

## Trying it without a VPS

```bash
bash deployment/vps/setup.sh --dry-run          # from a checkout
SHIPIT_DRY_RUN=1 bash -c "$(curl -fsSL …/deployment/vps/setup.sh)"   # or straight from the one-liner
```

Asks both questions, prints what the real run would do (including the
`SHIPIT_ACCESS` / `SHIPIT_HARNESSES` pair that repeats the same answers
non-interactively), and exits. It needs no root and writes no file.

**The dry run is in the installer, not beside it.** The first version of this
feature shipped a separate `preview-prompts.sh` that extracted the picker and
re-declared the option rows — which meant a second copy of the rows, the
defaults, and the explanatory prose, plus a test to pin them together. Putting
the questions in `resolve_access` / `resolve_harnesses` and branching on
`--dry-run` before the first host-touching step removes the copy entirely: what
an operator previews *is* what runs, and the pty tests drive the real
`setup.sh`.

The branch sits ahead of the saved-config read, so a dry run never needs root
and never touches `/etc/shipit`. The one question it cannot preview is the
egress-containment prompt, which only appears when a Docker probe fails on that
specific host; the summary says so.

## Key files

- `deployment/vps/setup.sh` — the picker, both question functions, and the dry run.
- `src/server/orchestrator/services/installer-picker.test.ts` — extracts the
  picker block and drives it under a pty (`script -qec`), asserting the key map,
  the `[*]`/`[ ]` rendering, the non-interactive return, and the validators'
  accepted inputs. The two echo assertions use a Python pty harness instead,
  because `script` delivers Ctrl-C to the whole foreground process group — any
  wrapper that could report the terminal state dies with the picker.
- `deployment/README.md` — operator-facing description of both questions.
