# Present tool — show artifacts without touching the workspace

The `present` tool displays a single self-contained visual artifact to the
user in ShipIt's dedicated **Present** tab — HTML pages, SVG diagrams,
rendered markdown, charts, or images — without writing files to the
workspace.

## When to use `present` vs `Write`

- Use **`present`** for things the user wants to *look at*: diagrams,
  mockups, charts, quick HTML prototypes, comparison views, rendered
  markdown docs. Anything ephemeral. The artifact never appears in the file
  tree and won't be auto-committed.
- Use **`Write`** for things the user wants to *keep*: source code,
  configuration, real documentation files, tests, anything that belongs to
  the project. These are deliverables and live in the workspace.

If the user later says "save that diagram to the repo," you can either
write the file directly with `Write` or instruct the user to click the
**Save** button in the Present tab (recommended — it preserves byte-exact
fidelity with what they saw).

## Parameters

```json
{
  "content": "<html>...</html>",
  "mimeType": "text/html",
  "title": "Architecture Diagram",
  "replaceId": "pres_abc123"
}
```

- **`content`** (required) — the artifact body as a string. For HTML/SVG/
  markdown, this is the raw markup. For images, this is a `data:` URI
  (e.g. `data:image/png;base64,...`).
- **`mimeType`** — `text/html` (default), `image/svg+xml`, `text/markdown`,
  `image/png`, `image/jpeg`, `image/gif`.
- **`title`** — a short label for the carousel header
  (e.g. "Sales Chart v2"). Optional but helpful when you present multiple
  artifacts in a session.
- **`replaceId`** — pass a previous `present` call's `presentId` to revise
  that entry in place. Use this for v1 → v2 iterations so the user isn't
  flipping between stale versions.

## Behavior

- HTML and SVG render inside a sandboxed iframe (`sandbox="allow-scripts"`)
  — JavaScript runs but the content can't read parent cookies, storage,
  or navigate the top frame.
- Markdown renders with the same renderer used elsewhere in ShipIt.
- Images render as `<img>` with the data URI directly.

## Iterating on visual artifacts (screenshot loop)

`present` returns `{ presentId, viewUrl }`. `viewUrl` is a worker-local URL
(e.g. `http://127.0.0.1:9100/present-files/pres_abc...`) that serves the exact
rendered artifact. Use it to *see your own output* and fix it before the user
has to:

1. Call `present({ content, mimeType, title })`.
2. `browser_navigate` to the returned `viewUrl`, then `browser_take_screenshot`.
3. Look for layout breaks, clipped SVG `viewBox`, overflow, low contrast, or a
   chart that rendered empty because its inline JS threw — defects you only
   catch by looking at the pixels.
4. Edit the content and call `present` again with `replaceId` set to the same
   `presentId` to revise in place. The user sees each revision land in the
   Present tab as you iterate.
5. Re-navigate to the same `viewUrl` and screenshot again to confirm the fix.

This is the same browser you use for live previews — nothing new to set up. The
artifact renders in real Chromium, so what you screenshot is what the user sees.
If a navigate returns 404, the presentation was evicted (the buffer keeps a
bounded most-recent set) — just call `present` again to get a fresh URL.

## Limits

- Single presentation: ~1 MB. Larger payloads are rejected with a clear
  error. Strip embedded base64 assets, simplify the artifact, or split it
  into multiple presentations.
- At most ~20 simultaneous presentations per session — older entries get
  LRU-evicted from both the buffer and the user's carousel.
- Presentations live in the agent container's memory only. They disappear
  when the container is stopped or the session is archived.

## Examples

```
present({
  content: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100'>...</svg>",
  mimeType: "image/svg+xml",
  title: "Component graph"
})
// → { presentId: "pres_abc...", status: "presented", viewUrl: "http://127.0.0.1:9100/present-files/pres_abc..." }
```

```
present({
  content: "# Release notes\n\n- Fixes ...\n- Improves ...",
  mimeType: "text/markdown",
  title: "Draft release notes"
})
```

```
// Revise an earlier mockup in-place
present({
  content: "<html>...</html>",
  mimeType: "text/html",
  title: "Landing page v2",
  replaceId: "pres_abc..."
})
```
