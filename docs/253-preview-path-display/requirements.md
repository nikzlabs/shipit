# Preview path display — requirements

What the preview toolbar must do, in the requester's terms. Design and mechanism
live in [`plan.md`](./plan.md).

## Requirements

1. The preview toolbar shows which page the preview is currently on.
2. It shows the **path and query string only** — not the host and not the port.
3. The displayed value stays correct as the user moves around inside the preview,
   including navigation that never reloads the page (client-side / SPA routing).
4. The display is **read-only**. Clicking it copies the full URL — host included —
   to the clipboard.
5. It occupies its own region of the toolbar, **left-aligned**.

## Resolved questions

- **2026-08-06 — Read-only display, or an editable address bar?**
  Asked whether the value should be editable so a path could be typed to navigate
  there. Answer: **read-only with click-to-copy**. Recorded as req 4. An editable
  address bar was not adopted; revisit only on a fresh request.

- **2026-08-06 — Where does it sit in the toolbar?**
  Offered its own region (browser-address-bar style) versus inline inside the
  existing left group, alongside a [mockup](./mockup.html) of both. Answer: **its
  own region, but left-aligned** rather than centred. Recorded as req 5.

## Open questions

_None._

## Non-requirements

Recorded so later readers don't mistake them for gaps:

- Showing the host or port anywhere on the toolbar face. Req 2 excludes it
  deliberately — the host is a generated subdomain (`a3f9c2--5173.localhost`)
  that carries no information for the user. It remains reachable via the
  click-to-copy value (req 4) and the existing "open in new tab" button.
- Navigating the preview by typing a path (settled above).
- Showing history depth, a forward button, or a breadcrumb of visited routes.
  Nothing was asked for beyond "where am I now".
