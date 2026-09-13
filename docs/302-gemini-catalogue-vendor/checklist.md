# 302 — Gemini API as a catalogue vendor: checklist

- [x] `requirements.md` written from the spawning brief; tracker issue planning#544 linked in the frontmatter
- [x] `ApiStyle` gains `gemini-generate-content` (`catalogue/types.ts`) (req 4)
- [x] Model identities and vision verdicts for `gemini-3.8-flash` and `gemini-3.1-pro-preview` (req 3)
- [x] `google` `ServiceDef` row: key mode, `GEMINI_API_KEY`, `generativelanguage.googleapis.com`, real prices and context windows (reqs 1–3)
- [x] `GEMINI_API_KEY` in the `dev` compose service's `x-shipit-secrets`; `onboarding` untouched (req 6)
- [x] `generativelanguage.googleapis.com` in the egress default, lifeline and Tier-A lists (guard: `egress-allowlist.test.ts`)
- [x] Gemini brand mark in `ServiceLogo.tsx` (the record is total over `ServiceId`)
- [x] `GEMINI_API_KEY` scrubbed from OpenCode spawns beside the other vendor keys it auto-detects
- [x] Catalogue guard test: the vendor joins no harness, its key still resolves, its models declare only the new style (req 5)
- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev`, catalogue and seed tests
- [x] Independent review via `shipit agent run --role reviewer`
- [x] Prices, ids, image input and context windows read first-hand on ai.google.dev — by the independent review, whose tools could reach the host when this session's could not (see `plan.md` § Provenance)
