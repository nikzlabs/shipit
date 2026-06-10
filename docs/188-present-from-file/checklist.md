# Present from a file — checklist

## Agent API (MCP bridge)

- [x] Replace `content` with required `file` in the `present` tool schema
- [x] Keep `mimeType` as an optional override; update its description
- [x] Rewrite the tool description: write a file, present by path; /tmp vs workspace
- [x] Forward `{ file, mimeType?, title?, replaceId? }` to the worker
- [x] Update `mcp-present-bridge.test.ts` (schema keys, required `file`, forwarded body)

## Worker

- [x] `inferPresentMimeType(path)` + `isBinaryPresentMime(mime)` helpers in `present-view.ts`
- [x] `/agent-ops/present/submit` accepts `file`, resolves relative→workspace / absolute→as-is
- [x] Infer MIME from extension (override via `mimeType`); unknown → `text/plain`
- [x] Read file: binary image → `data:` URI, else UTF-8 text
- [x] 400 with a clear message when the file can't be read
- [x] Reuse existing buffer.put + `present_content` SSE + `viewUrl`

## Docs

- [x] Rewrite `src/server/shipit-docs/present.md` file-based
- [x] `docs/188-present-from-file/plan.md` + this checklist
- [x] Cross-reference from `docs/093-agent-present/plan.md`

## Agent discoverability

- [x] Tool description carries the screenshot-loop trigger + "screenshot `viewUrl`, not the file" nuance + pointer to `present.md`
- [x] Make "screenshot `viewUrl`, not the file" explicit in `present.md`
- [x] Add `present.md` to the system prompt's "Key docs" list (`agent-instructions.ts`) so it's discoverable

## Verification

- [x] `inferPresentMimeType` unit coverage (via present-view.test.ts additions)
- [x] Integration: file-based submit → SSE → runner WS (`present-flow.test.ts`)
- [x] Integration: missing-file submit returns 400
- [x] `npm run typecheck` clean
- [x] `npm run lint:dev` clean
- [ ] Manual: present a `/tmp` file (ephemeral) and a workspace file (tracked); confirm both render and the workspace one shows in the file tree + commits
- [ ] Manual: edit a file + re-present with `replaceId`; confirm in-place revision
