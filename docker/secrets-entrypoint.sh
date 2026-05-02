#!/bin/sh
# ShipIt secrets entrypoint wrapper (087-reusable-preview-secrets, Phase 1
# follow-up).
#
# Docker Compose mounts secrets as files under /run/secrets/<name>, but most
# applications expect environment variables. This wrapper reads every file
# under /run/secrets/ that starts with `shipit-`, exports it as an env var
# (stripping the prefix), then exec's the original command.
#
# The `shipit-` prefix namespaces ShipIt-managed secrets so they don't
# collide with other compose secrets the user's compose file might declare.
#
# Designed to be mounted read-only into compose service containers as
# `/shipit/secrets-entrypoint.sh` and set as the service's `entrypoint:`.
# The original `command:` (or the image's default CMD) is forwarded verbatim
# via `exec "$@"` so signal handling, exit codes, and PID 1 semantics behave
# the same as without the wrapper.

set -e

if [ -d /run/secrets ]; then
  for f in /run/secrets/shipit-*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    var="$(printf '%s' "$name" | sed 's/^shipit-//')"
    # POSIX-portable export of a dynamic variable name + file contents.
    eval "export ${var}=\"\$(cat \"\$f\")\""
  done
fi

exec "$@"
