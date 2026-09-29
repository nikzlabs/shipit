# 318 — Remote model list: checklist

- [x] `model-list.ts`: document type, export, parse with validation, live apply
- [x] Catalogue functions read the live list; `ModelDef.canonicalModelKey` widened to `string`
- [x] `models.json` generated; `npm run catalogue:export`; sync test
- [x] Context windows (`modelContextWindows()`) and harness model lists read the live list
- [x] Orchestrator: cache load at startup, hourly fetch, refresh + `agent_list` broadcast
- [x] Browser applies `modelList` from bootstrap and `agent_list`
- [x] Worker applies `modelList` from `/agent/start` and `/agent/spawn`
- [x] Tests for parse, apply, fetch/cache, registry, client, worker
- [x] Wiki and `services.ts` header name the export step
