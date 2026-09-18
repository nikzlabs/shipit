#!/bin/sh
set -e

if [ -d /run/secrets ]; then
  for f in /run/secrets/shipit-*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    var="$(printf '%s' "$name" | sed 's/^shipit-//')"
    eval "export ${var}=\"\$(cat \"\$f\")\""
  done
fi

exec "$@"
