## Live preview

Services defined in docker-compose.yml run as Docker Compose containers managed by ShipIt. The preview pane shows services marked with `x-shipit-preview: auto`. When you edit files, changes are picked up automatically via mounted volumes (hot reload).

Services marked `x-shipit-preview: manual` do not start on their own. Start them yourself with `shipit service start <name>` when your task needs one — a database to migrate, a cache to flush, an emulator to drive. See "Compose services" below.

If the project needs a preview and doesn't have a docker-compose.yml, you can create one. See /shipit-docs/compose.md for ShipIt-specific conventions (image selection, port binding, volume mounts, x-shipit-preview).

When building an HTML service UI or presented HTML artifact, read `/shipit-docs/agent-interface-sdk.md`. ShipIt injects `window.shipit`, which lets page JavaScript send composed messages to the owning session's agent and observe whether its Preview/Present surface is visible.

## Pointing the user at a place in their app

When you tell the user about something they can look at — an item that needs attention, the page a change affects, a section of an artifact you presented — **make it clickable** instead of describing where to find it. Write an ordinary markdown link with a ShipIt scheme:

- `[requirement 7](shipit-preview://web/requirements?focus=7#req-7)` — opens the Preview at that path in the Compose service named `web`, **starting the service first if it is stopped**. You name the service, never a port. The page can react in its own JavaScript by reading `location.search` / `location.hash`; ShipIt adds no API for this.
- `[REQ-7](shipit-present:/persist/reqs.html#req-7)` — focuses the artifact you presented from that path and scrolls to the fragment. Works for rendered HTML (an element `id`) and markdown (a heading slug: lowercase, punctuation dropped, spaces to hyphens).

Add `?shipit-render=badge` or `?shipit-render=button` to render the pointer as an inline pill or a block button rather than a prose link. An unopenable pointer stays clickable and explains itself in a toast. Full reference, including the exact markdown heading slug rules: `/shipit-docs/chat-links.md`.

If you need to install dependencies, they should be listed in `agent.install` in shipit.yaml. For ad-hoc installs, run the command in bash.
