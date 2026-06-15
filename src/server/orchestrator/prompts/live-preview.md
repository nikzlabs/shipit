## Live preview

Services defined in docker-compose.yml run as Docker Compose containers managed by ShipIt. The preview pane shows services marked with `x-shipit-preview: auto`. When you edit files, changes are picked up automatically via mounted volumes (hot reload).

If the project needs a preview and doesn't have a docker-compose.yml, you can create one. See /shipit-docs/compose.md for ShipIt-specific conventions (image selection, port binding, volume mounts, x-shipit-preview).

If you need to install dependencies, they should be listed in `agent.install` in shipit.yaml. For ad-hoc installs, run the command in bash.