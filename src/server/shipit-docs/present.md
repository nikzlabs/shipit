# Present tool — render a file in the Present tab

The `present` tool displays a single self-contained file to the user in
ShipIt's dedicated **Present** tab — an HTML page, an SVG diagram, a rendered
markdown doc, a chart, or an image. You **write the file first** (with the
`Write` tool), then call `present` with its path.

## Ephemeral vs. tracked — it's just where you write the file

`present` renders whatever file you point it at. The path's location is the
only thing that decides whether the artifact is throwaway or kept:

- **Throwaway** — write the file under **`/tmp`** (e.g. `/tmp/chart.html`).
  It never enters the workspace, the file tree, or git. Use this for quick
  diagrams, mockups, and previews the user only needs to look at.
- **Tracked** — write the file **into the workspace** (e.g.
  `docs/mockups/landing.html`). It shows up in the file tree, gets
  auto-committed like any other file, **and** renders in the Present tab. Use
  this when the prototype is a deliverable you want reviewed in the PR.

There is no separate flag — pick the directory that matches your intent.

## When to use `present` vs `Write` alone

- Use **`present`** when you want the user to *see* a rendered visual: write
  the file, then present it. Works for both throwaway (`/tmp`) and tracked
  (workspace) files.
- Use **`Write` alone** for files that don't need rendering — source code,
  configuration, tests, plain documentation. These are deliverables; they
  don't belong in the Present tab.

## Parameters

```json
{
  "file": "/tmp/architecture.html",
  "title": "Architecture Diagram",
  "replaceId": "pres_abc123"
}
```

- **`file`** (required) — path to the file to present. Relative paths resolve
  against the workspace (your cwd); absolute paths (e.g. `/tmp/chart.html`)
  are read as-is. Write the file before calling `present`.
- **`mimeType`** — optional override. By default the MIME type is **inferred
  from the file extension**: `.html`/`.htm` → `text/html`, `.svg` →
  `image/svg+xml`, `.md`/`.markdown` → `text/markdown`, `.png` → `image/png`,
  `.jpg`/`.jpeg` → `image/jpeg`, `.gif` → `image/gif`, `.webp` →
  `image/webp`. Unknown extensions fall back to `text/plain`.
- **`title`** — a short human-friendly **name** for the artifact, shown as the
  heading in the Present tab (e.g. "Sales Chart v2"). The tab header always
  shows the **full file path** beneath it; `title` is the friendly name on top.
  Optional — without it the header uses the file's name — but helpful when you
  present multiple artifacts in a session.
- **`replaceId`** — pass a previous `present` call's `presentId` to revise that
  entry in place. Edit the file, then call `present` again with the same
  `replaceId` so the user isn't flipping between stale versions.

## Behavior

- HTML and SVG render inside a sandboxed iframe (`sandbox="allow-scripts"`)
  — JavaScript runs but the content can't read parent cookies, storage,
  or navigate the top frame.
- Markdown renders with the same renderer used elsewhere in ShipIt.
- Images render as `<img>`. The worker reads the file's bytes and encodes
  them, so you point `present` at the image file directly — no need to inline
  a data URI yourself.

## Iterating on visual artifacts (screenshot loop)

`present` returns `{ presentId, viewUrl }`. `viewUrl` is a worker-local URL
(e.g. `http://127.0.0.1:9100/present-files/pres_abc...`) that serves the exact
rendered artifact. Use it to *see your own output* and fix it before the user
has to:

1. Write the file, then call `present({ file, title })`.
2. `browser_navigate` to the returned `viewUrl`, then `browser_take_screenshot`.
3. Look for layout breaks, clipped SVG `viewBox`, overflow, low contrast, or a
   chart that rendered empty because its inline JS threw — defects you only
   catch by looking at the pixels.
4. Edit the file and call `present` again with `replaceId` set to the same
   `presentId` to revise in place. The user sees each revision land in the
   Present tab as you iterate. **Re-presenting is also how you reload** — there
   is no live file watcher; call `present` again after editing the file.
5. Re-navigate to the same `viewUrl` and screenshot again to confirm the fix.

This is the same browser you use for live previews — nothing new to set up. The
artifact renders in real Chromium, so what you screenshot is what the user sees.
If a navigate returns 404, the `presentId` is unknown or its file is no longer
on disk — just call `present` again to get a fresh URL.

**Always screenshot `viewUrl`, never the file directly** (no `file://`, no
opening the path in the browser). `viewUrl` runs the same renderer as the user's
Present tab — it converts markdown to HTML, wraps SVG zero-margin, and decodes
images. The raw file does none of that, so a screenshot of it would not match
what the user sees and would defeat the point of the check.

## Limits

- No artifact-size or count caps. A presentation always shows, no matter how
  large, and every artifact of the session stays in the carousel.
- The worker keeps only the file's PATH, not its bytes — they're read from disk
  on demand whenever the artifact is served (your screenshot `viewUrl`, the
  user's Present tab). So the file must still exist when it's viewed: a `/tmp`
  throwaway survives for the container's lifetime; a workspace file survives as
  long as it's there. If you overwrite or delete the file, the next view
  reflects that. Re-present (or write the file again) to restore it.
- Presentations disappear when the container is stopped or the session is
  archived. A presentation backed by a tracked workspace file still survives as
  a committed file — re-present it to bring it back into the tab.
- There is no user-facing "save" button. If the user wants to keep a `/tmp`
  artifact, they'll ask you to write it into the repo — just `present` a file
  you've written to the workspace, or write it there on request.

## Examples

```
// Throwaway diagram — write to /tmp, present, never touches git
// (after Write to /tmp/component-graph.svg)
present({ file: "/tmp/component-graph.svg", title: "Component graph" })
// → { presentId: "pres_abc...", status: "presented", viewUrl: "http://127.0.0.1:9100/present-files/pres_abc..." }
```

```
// Tracked mockup — write into the workspace so it's committed AND rendered
// (after Write to docs/mockups/release-notes.md)
present({ file: "docs/mockups/release-notes.md", title: "Draft release notes" })
```

```
// Revise an earlier mockup in-place: edit the file, then re-present
// (after editing /tmp/landing.html)
present({ file: "/tmp/landing.html", title: "Landing page v2", replaceId: "pres_abc..." })
```
