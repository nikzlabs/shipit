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

### When the toolbar runs out of width

6. The toolbar never clips. No control is allowed to fall off the edge and
   become unreachable, at any panel width.
7. The other toolbar labels collapse to icons **first**. Only once they are all
   icons does the address begin to shrink.
8. The address **shrinks**; it is never hidden while space for it remains. It
   always shows as much of the value as the available width holds, so a
   shortened address never has unused space beside it.
9. The copy control (req 4) stays visible at every width — including when the
   address text has shrunk away to nothing.

## Resolved questions

- **2026-08-16 — What gives way first when the toolbar is too narrow?**
  Raised from a phone screenshot of the toolbar clipping. Five options were
  mocked ([`overflow-mockup.html`](./overflow-mockup.html)): staged label
  collapse, an overflow kebab, two rows, horizontal scroll, and splitting
  navigation from configuration. The first mockup had the address give way
  first; that was **rejected** — "the service name should collapse before the
  address. First all elements collapse to icons, then the address shrinks."
  Recorded as req 7.

- **2026-08-16 — May the address be hidden outright once it is too narrow?**
  The rejected mockup hid it at a threshold, which left a visible gap beside the
  copy button — "there is place for part of the address but it is not there."
  Answer: **no**, it shrinks and always uses the space that exists. Recorded as
  req 8.

- **2026-08-16 — Does the copy control survive the address text?**
  Answer: **yes**, "crucial to have, even if the url text itself is fully
  hidden." Recorded as req 9. Note this was already broken before any collapse
  existed: the icon was `shrink-0` but sat in a region free to collapse to zero,
  so it was clipped away together with the text.

- **2026-08-16 — How much address is protected before labels start dropping?**
  Offered as a slider over the mockup rather than as a number in prose. Answer:
  **130px**. This is a tuning value for req 7, not a requirement of its own —
  it decides only how early labels give way, and at 130px the first label goes
  at a panel width of about 680px.

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
