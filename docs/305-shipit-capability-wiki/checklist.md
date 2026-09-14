# Checklist — ShipIt capability wiki

## First slice

- [x] `requirements.md`, with the voice contract recorded as reqs 9–10
- [x] `plan.md` — placement, voice contract, discovery, page map
- [x] `wiki/README.md` — index, question map, voice contract, live-query rule
- [x] `wiki/how-shipit-works.md` — the model, the screen, the capability census
- [x] `wiki/sessions.md`
- [x] `wiki/installing-and-updating.md`
- [x] `shipit-docs/README.md` points at the wiki
- [x] `CLAUDE.md` maintenance rule for user-facing behaviour
- [x] Root `README.md` links the wiki, so a host agent finds it
- [x] Gap audit of all three pages — every inherited claim re-verified in code,
      unanswered user questions closed, every named control checked for its
      condition

## Remaining pages

Each one is a page in `src/server/shipit-docs/wiki/`, written under the voice
contract in `wiki/README.md`, and added to that file's question map and to the
census in `how-shipit-works.md`.

- [ ] `chat.md` — attachments, `@` files, `/` skills, interrupt and queue,
      permission prompts, questions, dictation, voice notes, collapsed turns,
      the context dial and compaction, goals, Present, proposed actions
- [ ] `previews.md` — what the preview is, Compose services, service control,
      device viewports, preview errors, why a preview is blank
- [ ] `pull-requests.md` — the card, review threads, the user's own review flow,
      merge methods, auto-merge, CI and auto-fix, conflicts, rollback, releases
- [ ] `issues-and-docs.md` — trackers, the Issues panel, starting from an issue,
      closing on merge, the Docs tab, selection comments
- [ ] `settings-and-accounts.md` — the ten tabs, provider accounts and fallback
      order, harnesses, model/effort/role, usage and limits, themes, keybindings
- [x] `repos-and-sandboxes.md` — adding a repo, trust, repo colours, sandbox
      sessions and their capabilities, secrets
- [ ] `plugins-and-skills.md` — what the user sees, marketplaces, MCP servers
- [ ] `deploying.md` — targets, prerequisites, status on the card
- [ ] `troubleshooting.md` — the questions users actually ask when it misbehaves
- [ ] Backing up and moving an installation — no page and no section covers it;
      it belongs in `installing-and-updating.md` once the facts are verified

## Before each page ships

- [ ] Every claim verified against code or a shipped feature's requirements —
      not against a design doc, which may describe intent that never landed
- [ ] **Every named control checked for its condition.** The first slice's
      review found four errors of this one shape: a control named in the wrong
      panel, or promised on installs and sessions that do not have it. A tab, a
      button or a menu item is only correct together with when it appears.
- [ ] No setting value, service list, role or tracker written down; the live
      command named instead
- [ ] Read once more for the voice contract: no command addressed to the user
