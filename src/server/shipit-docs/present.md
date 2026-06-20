# Present tool — render files in the Present tab

The `present` tool displays self-contained files to the user in ShipIt's
dedicated **Present** tab — an HTML page, an SVG diagram, a rendered markdown
doc, a chart, or an image. You **write the file first** (with the `Write`
tool), then call `present` with its path.

**Each call presents one file, but multiple presentations coexist in the tab.**
The Present tab is a carousel: every `present` call (without `replaceId`)
*appends* a new entry, and they all stay visible together. So when you produce
several artifacts the user should compare — three landing-page variants, a
before/after pair, a set of charts — **present them all**: write each file and
call `present` once per file. Don't show a single variant and point the user
elsewhere for the rest; that limitation doesn't exist. Use `replaceId` only
when you mean to *revise one existing entry in place* (v1 → v2), not to swap
between artifacts you want shown side by side.

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

## Presenting multiple artifacts at once

There is **no one-at-a-time limit**. Each `present` call shows one file, and
every call appends to the carousel, so showing N artifacts is just N calls:

```
// Three design variants, all shown together in the Present tab
// (after writing each file)
present({ file: "/tmp/variant-a.html", title: "Variant A — minimal" })
present({ file: "/tmp/variant-b.html", title: "Variant B — bold" })
present({ file: "/tmp/variant-c.html", title: "Variant C — playful" })
// → three entries the user can flip between, no replaceId on any of them
```

Give each a distinct `title` so the carousel headings tell them apart. The two
flows are orthogonal:

- **Add** another artifact → call `present` with no `replaceId` (new entry).
- **Replace** one artifact in place → call `present` with `replaceId` set to its
  `presentId` (revise v1 → v2, see below).

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
  one entry in place. Edit the file, then call `present` again with the same
  `replaceId` so the user isn't flipping between stale versions. **Omit it** to
  add a new entry alongside the existing ones — that's how you present several
  artifacts at once (one call per file, none of them carrying `replaceId`).
  Reach for `replaceId` only when superseding a version of the *same* artifact,
  never to switch between artifacts you want shown together.

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
- Present-tab artifacts **persist across a reload, a session switch, and a
  container restart** — their metadata is saved durably on the orchestrator (not
  in the container), and the bytes are re-read from the source file on demand.
  So a presentation backed by a **tracked workspace file** comes back and
  re-renders fully after the session container is recycled, because the
  committed file is still on disk. A **`/tmp` throwaway** whose file did not
  survive the restart shows a graceful "source no longer available" placeholder
  in the tab instead of vanishing — re-present (or re-write the file) to restore
  it. The Present tab is only fully wiped on a session delete / full reset.
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
