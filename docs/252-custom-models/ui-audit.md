---
title: Custom models — shipped UI vs the docs/252 mockups
description: Gap report comparing the shipped Settings, composer pickers and usage modal against mockup-services, mockup-picker and mockup-usage.
---

# 252 — UI audit: what shipped, and what the mockups still show

An audit, not a change. Nothing in product code was touched.

**Method.** The dogfood instance (`shipit service start dev`, `RUNTIME_MODE=local`) was
seeded with five credentials through the real UI and `POST /api/credential-routes`
(DeepSeek key, GLM subscription ×2, GLM key, OpenRouter key), then driven in the browser.
The four mockups were served over HTTP and driven in the **same browser** at the same
viewport. Screenshots of both are in [`audit-shots/`](./audit-shots/).

One surface could not be driven visually: the **usage modal**. It opens from the context
dial, which mounts only after a session records context tokens, and no harness in the
dogfood instance has a working credential to take a turn with. That row of the table is a
**source-level** comparison of `UsageModal.tsx` against `mockup-usage.html`, and is marked
as such.

## Screenshots

| Surface | Mock | Shipped |
|---|---|---|
| Settings → Services | [`mock-services.png`](./audit-shots/mock-services.png) | [`shipped-services.png`](./audit-shots/shipped-services.png), [`shipped-services-anthropic-revealed.png`](./audit-shots/shipped-services-anthropic-revealed.png) |
| Settings nav / default tab | (mock nav is inside `mock-services.png`) | [`shipped-settings-default-tab.png`](./audit-shots/shipped-settings-default-tab.png), [`shipped-settings-claude-tab.png`](./audit-shots/shipped-settings-claude-tab.png), [`shipped-settings-codex-tab.png`](./audit-shots/shipped-settings-codex-tab.png) |
| Add-a-service dialog | inside `mock-services.png` | [`shipped-add-service-dialog.png`](./audit-shots/shipped-add-service-dialog.png), [`shipped-add-anthropic-sub-step3.png`](./audit-shots/shipped-add-anthropic-sub-step3.png) |
| Composer pickers | [`mock-picker-model-menu.png`](./audit-shots/mock-picker-model-menu.png), [`mock-picker-harness-menu.png`](./audit-shots/mock-picker-harness-menu.png) | [`shipped-picker-model-menu.png`](./audit-shots/shipped-picker-model-menu.png), [`shipped-picker-harness-menu.png`](./audit-shots/shipped-picker-harness-menu.png) |
| Usage | [`mock-usage-session.png`](./audit-shots/mock-usage-session.png), [`mock-usage-all.png`](./audit-shots/mock-usage-all.png) | source only |
| Harnesses (explanatory only) | [`mock-harnesses.png`](./audit-shots/mock-harnesses.png) | — cut, see D12 |

## Categories

- **(a) Never built** — the design says it ships and it is not there.
- **(b) Deliberately cut** — `plan.md` says so; the line is cited.
- **(c) Built but visually different** — it works, it does not look like the mock.
- **(d) Mockup is stale** — a later decision superseded what the mock shows.

## Divergences, most visible first

| # | Surface | Mock shows | Ships | Cat. | Evidence | Fix cost |
|---|---|---|---|---|---|---|
| D1 | Settings nav | Nav is `Services / Harnesses / Git / Instructions / Voice / Advanced`. No per-vendor tabs. Services is first and is where you land. | An **Agent** group leads the sidebar with `Claude` and `Codex`, then a **General** group whose third item is `Services`. Settings **opens on `agent-claude`**. | (a) for the ordering / default; the mock's `Harnesses` entry is (b) | `Settings.tsx:23` (tab union), `:68` (`?? "agent-claude"`), `:144-165` (Agent group rendered first), `:99` (Services third in `generalTabs`) | Small: reorder the list, change the default tab, and re-home the two things the vendor tabs uniquely hold (D2, D3). |
| D2 | Settings → Services, account-backed subscription | One uniform card per `(service, mode)`: avatar, **service** name ("Anthropic"), `Subscription` pill, `2 accounts` pill, `Add account`, account rows with quota bars, **model chips**, and a shaded routing footer. | A bare `ProviderAccountsCard` with **no card border**, headed "**Claude subscriptions**" (the *harness* vendor, not the service), no mode pill, no account-count pill, and **no model chips**. It reads as a different component sitting above the card list, because it is one. | (c) | `ServicesPanel.tsx:226-232` renders `ProviderAccountsCard` outside the card `<div>`; the chips at `:287-296` are inside the `stringRoutes.length > 0` branch only. `ProviderAccountsCard.tsx:499` `{name} subscriptions`. See `shipped-services-anthropic-revealed.png`. | Medium: wrap the accounts card in the same card chrome, title it from the catalogue service name, and lift the chips out of the string-only branch. |
| D3 | Settings → Services, reaching the OAuth login | `Add account` is on the service card, always. | The Anthropic/OpenAI card only appears once an account exists, a notice exists, **or** the user walks the add-flow and presses *Continue to sign in*. That reveal is component-local state, and `TabsContent` unmounts on tab change — **verified**: revealing the card, switching to `Git` and back removes it, with no way to reach `Add account` again except redoing the whole add-flow. | (a) — a defect, not a design choice | `ServicesPanel.tsx:102` (`const [revealed, setRevealed] = useState<string[]>([])`), `:115-122` (the `configured` filter), `:652-656` (`revealAccountCard`) | Small: lift `revealed` to the settings store, or make an account-backed mode always render its card. |
| D4 | Add-a-service, step 3 for Anthropic Subscription | `3 · SIGN IN`, prose, model chips, one primary **Sign in** button. | Heading reads `3 · PASTE THE KEY` while the prose says it is connected by signing in; a `sk-…` password field is shown **above** the sign-in prose, and the primary button is `Save` (the key) with `Continue to sign in` demoted to secondary. | (c); the mock is also (d) here — it never depicted that Anthropic's subscription accepts a string (`claude-env-oauth`) as well as an account | `ServicesPanel.tsx:735` (`3 · {acceptsString ? "Paste the key" : "Sign in"}`), `:783-805` (button variants). See `shipped-add-anthropic-sub-step3.png`. | Small: when a mode accepts both, title the step for the *primary* path and make sign-in the primary button. |
| D5 | Settings, status dot | (no equivalent — the mock has no per-harness card) | The dot beside "**Claude** subscriptions" is **green with no Anthropic subscription connected**, because the flag behind it means "this harness has at least one eligible model" (it went green after a DeepSeek key was added). The card body two lines below says "No Claude subscription connected yet." | (c) — a contradiction the feature introduced | `ProviderAccountsCard.tsx:467` (`runnable = agent?.hasRunnableModels`), `:489-499`. **Still reproduces after the `authConfigured` → `hasRunnableModels` rename** — that renamed the flag without changing what drives the dot. See `shipped-settings-claude-tab.png`. | Small: drive the dot from `accounts.length`/route status, not from whether the harness has runnable models. |
| D6 | Credential row | `sk-•••••••4f2a · metered, no quota to report` — the row identifies **which secret** is stored. | The row shows only the generated label (`DeepSeek key`, `GLM (Z.ai) plan 2`). Nothing identifies the secret, so two credentials of one subscription are distinguishable only by an auto-numbered label. | (a) | `ServicesPanel.tsx:512` renders `{route.label}` and nothing else; `CredentialRoute` carries no masked form (`credential-route.ts:60-80`, and its docstring states "**No secret on this record**"). | Medium: needs a server-side masked fingerprint on the wire shape, then one row change. |
| D7 | Subscription card, routing controls | A visually separate shaded footer titled **HOW SHIPIT PICKS BETWEEN THESE ACCOUNTS**, holding the two radios and the cutoff row. | The two radios sit inline in the card body with **no section heading**, between the credential rows and the model chips. | (c) | `ServicesPanel.tsx:280-285`, `:375-391`. See `shipped-services.png` (GLM subscription card). | Small: a heading and a background band. |
| D8 | Subscription card with one credential | An explanatory strip: "One account — nothing to route between yet. Add a second to choose an order and a strategy." | Nothing. The routing block is simply absent. | (c) | `ServicesPanel.tsx:280` (`multiple && stringRoutes.length > 1`) | Small, but weigh it against `plan.md:2069-2072`, which argues *against* sentences explaining an absence (for the key card). | 
| D9 | Every card header | Service avatar/initial badge; account-count pill (`2 accounts`). | Neither. | (c) | `ServicesPanel.tsx:238-255` | Small, cosmetic. |
| D10 | Model menu, group header | `SERVICE NAME` at left, billing mode as a **coloured pill** at the right edge (purple `Subscription`, green `API key`). Model rows are mono model ids. | Service name plus billing mode as **plain tertiary text** immediately after it; rows use friendly labels (`V4 Flash`, `Opus 5`), so the same model reads as `V4 Flash` under DeepSeek and `DeepSeek V4 Flash` under OpenRouter. | (c) | `ModelPicker.tsx:477-482` (label), `:497` (`row.label ?? formatModelName`). Compare `mock-picker-model-menu.png` / `shipped-picker-model-menu.png`. | Small: pill styling; the label inconsistency is a catalogue-label question. |
| D11 | Harness menu row | Two lines — name, then `7 models available` beneath it. | One line — name, then `9 models` right-aligned; an uncredentialed harness reads `needs a credential` and is disabled. | (c), and the disabled-state copy is an improvement the mock lacks | `ModelPicker.tsx:212-243` | Cosmetic. |
| D12 | Settings → Harnesses | A whole screen: harness × API style × services-it-can-drive, plus the Background-work row. | Does not exist. | **(b)** | `plan.md:2001-2008` — "**So there is no Settings → Harnesses screen**, and dropping it is a real scope cut rather than a deferral." | n/a — do not build. |
| D13 | Background work | Lives on the Harnesses screen as a one-line row: `Runs on · [Automatic — first available] · currently · [Anthropic · opus-5] · Change`. | Lives at the bottom of **Services**, as a labelled `<select>` with a long description, plus `Currently: DeepSeek · V4 Flash · runs on Claude Code`. | (c) placement + shape; the mock is (d) on content — it omits the derived harness that req 9 requires | `ServicesPanel.tsx:187-189`, `BackgroundWorkSection.tsx:136-188`; `plan.md:2008` explicitly keeps this obligation after cutting the screen. | None needed — this is the design working. Optionally compress the copy. |
| D14 | Failover cutoffs on a string-delivered subscription | The mock's subscription card carries `Move off an account past [90] % session [90] % weekly`. | Absent for GLM. Present only on account-backed subscriptions (inside `ProviderAccountsCard`). | **(b)** | `ServicesPanel.tsx:303-320` docstring; `checklist.md:58-61`, blocked on the `zai-plan-usage` quota reader (**planning#339**). | n/a until the quota reader lands. |
| D15 | Usage modal *(source-only comparison)* | Two headlines (`METERED SPEND (EST.)` / `INCLUDED IN PLANS` with `≈ $x at API rates`), per-`(service, mode)` rows with `Included` + quota %, a legacy `No service recorded / Unattributed` row, and a `Paid / At API rates / Tokens` weekly toggle. | All of it, with one deliberate copy change: the toggle's first option is **`Metered`**, not `Paid`. | (d) — the code states why | `UsageModal.tsx:66-74` ("'Metered', not 'Paid' … Labelling that 'Paid' asserts a fact about a bank statement"), `:300-345`, `:405-457` | None. Update the mock's label if the mocks are to stay authoritative. |
| D16 | Sub-agent defaults | Appears in **no** mockup at all. | Only inside the vendor tabs. It is per-harness by nature (reasoning levels are the CLI's; the model list is the harness's eligible set), so removing those tabs leaves it homeless. | **(a) design gap** — the design never placed it | `ClaudeTab.tsx:30`, `CodexTab.tsx:26`, `SubAgentDefaultsSection.tsx:96`; `plan.md` never mentions the section | Medium: it is a genuine per-harness setting, and the design has no per-harness surface left (D12). It needs a decision, not just a move. |

## What the vendor tabs uniquely provide

This was the crux question. The two tabs render exactly two components each:

```
ClaudeTab = ProviderAccountsCard(provider="claude", showApiKeyFallback=true) + SubAgentDefaultsSection(claude)
CodexTab  = ProviderAccountsCard(provider="codex",  showApiKeyFallback=true) + SubAgentDefaultsSection(codex)
```

Taking them one at a time:

1. **`ProviderAccountsCard` is not unique.** Services renders the *same component* for an
   account-backed `(service, sub)` mode (`ServicesPanel.tsx:226-232`), only with
   `showApiKeyFallback={false}`. Account rows, the OAuth / device-code login, the fallback
   order, the selection mode and the failover cutoffs are all reachable from Services.

2. **The OAuth login is reachable from Services — but not reliably.** The path is
   *Add a service → Anthropic → Subscription → Continue to sign in*, which reveals the card
   so its `Add account` button starts the real login. That reveal does not survive a tab
   switch (D3, verified in the browser). So today the vendor tab is the only **dependable**
   route to a first sign-in, which is a bug in Services rather than a capability of the tab.

3. **The API-key panel is genuinely redundant.** `Use an API key instead` writes through to
   the *same* credential route the Services add-flow writes:
   `setApiKey` → `upsertSingleStringCredential(store, "anthropic", "key", …)`
   (`services/settings.ts:664-670`), and `set_agent_env` routes any name the catalogue
   claims as a mode's `storageEnv` to the same place (`services/settings.ts:634-636`).
   A key saved on the Claude tab therefore appears as an `Anthropic · API key` card in
   Services. Two entry points, one fact. (One asymmetry worth knowing: `setApiKey`
   rejects anything not starting with `sk-ant-`; the generic route endpoint does not.)

4. **`SubAgentDefaultsSection` is the one thing with nowhere else to go** — see D16. It is
   docs/217 work that predates this feature, it is per-harness, and docs/252 removed the
   only per-harness surface the design had.

**Conclusion of fact:** apart from the sub-agent defaults, the vendor tabs hold nothing
Services does not, once D3 is fixed. Stated as fact, per the brief — no deletion is
proposed here.

## Where reasoning effort is settable today

Confirmed from the code, not assumed:

- **Per session, in the composer** — `ReasoningSelector`, the third trigger beside harness
  and model (`MessageInput.tsx:955`, visible as `⊙ Default` in the shipped screenshots). This
  is docs/217 Control B and is where `mockup-picker.html` puts it.
- **Per harness, as a sub-agent default** — `SubAgentDefaultsSection.tsx:216-237`, inside
  the vendor tabs (docs/217 Control A).
- **Nowhere else.** `BackgroundWorkSection` has no reasoning control, and Settings →
  Services has none.

That matches the design: the 2026-08-08 receipt in `requirements.md` settles that reasoning
is a property of the **harness**, that this feature adds nothing to it, and `plan.md:1953`
keeps it in the composer.

## Where the mockups and `plan.md` contradict each other

Four places. Each is the mock being stale, not the plan being wrong.

1. **`mockup-services.html`'s nav lists `Harnesses`** — the screen `plan.md:2001` explicitly
   cut. The nav in the shipping-target mock therefore advertises a screen that will never
   exist.
2. **`mockup-services.html` renders GLM's subscription as account-backed** — a *Sign in*
   step 3, account rows, a quota bar. The catalogue and `plan.md:2076-2081` make GLM's
   coding plan a **string-delivered subscription** (a subscription authenticated by a key),
   which is precisely why it was chosen as the test case. The shipped card is right and the
   mock is wrong.
3. **`mockup-harnesses.html`'s Background-work row omits the harness** (`Runs on ·
   Automatic — first available · currently · Anthropic · opus-5`), while req 9 and
   `plan.md`'s phase 7 require the derived harness to be shown as a fact. The shipped
   control adds `runs on Claude Code`.
4. **`mockup-usage.html` labels the weekly toggle `Paid`**; the shipped label is `Metered`,
   and `UsageModal.tsx:66-74` records why the mock's word was rejected.

A fifth, smaller one: the mock's add-dialog lists **Fireworks**, which is not in the shipped
catalogue. That is illustrative rather than a req 15 obligation — req 15's named minimum
(Anthropic, OpenAI, DeepSeek, GLM, OpenRouter, Vercel) all ship.
