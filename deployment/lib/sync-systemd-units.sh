#!/bin/bash
# Synchronize installed systemd units with the checkout.
# Usage: shipit_sync_systemd_units <unit-source-dir> <installed-unit-dir>

SHIPIT_SYSTEMD_UNITS=(
  shipit-updater.service
  shipit-updater.path
  shipit-restarter.service
  shipit-restarter.path
)

shipit_sync_systemd_units() {
  local src_dir="$1" unit_dir="$2"
  local unit src

  if [ ! -d "$unit_dir" ] || [ ! -w "$unit_dir" ]; then
    return 0
  fi

  for unit in "${SHIPIT_SYSTEMD_UNITS[@]}"; do
    src="$src_dir/$unit"
    [ -f "$src" ] || continue
    # Keep cmp inside the condition so differences do not trip `set -e`.
    if ! cmp -s "$src" "$unit_dir/$unit"; then
      # Rename a sibling file atomically to avoid a partial live unit.
      if cp "$src" "$unit_dir/.$unit.new" && mv "$unit_dir/.$unit.new" "$unit_dir/$unit"; then
        echo "==> Updated systemd unit $unit"
      else
        rm -f "$unit_dir/.$unit.new"
        echo "WARNING: could not install $unit into $unit_dir" >&2
      fi
    fi
  done

  # Always retry a prior failed reload, even when files already match.
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload \
      || echo "WARNING: systemctl daemon-reload failed; unit changes apply on the next reload." >&2
  fi
  return 0
}
