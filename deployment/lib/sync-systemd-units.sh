#!/bin/bash
# Keep the systemd units installed on the host in step with the checkout.
#
# setup.sh copies them at PROVISIONING time only, and nothing else did — so a
# change to a unit (the updater's TimeoutStartSec=, say) sat in the repo and
# never reached a host that was already running, however many times it updated.
# deploy.sh calls this on every deploy for the same reason it derives the
# hostname there rather than at setup time: existing installs update through
# update.sh -> deploy.sh, and are asked nothing.
#
# Sourced by deploy.sh; kept separate so it can be driven by a test.
# Usage: shipit_sync_systemd_units <unit-source-dir> <installed-unit-dir>

# The units setup.sh installs. A unit absent from the source dir is skipped, so
# this list can name a unit that does not exist yet on an older checkout.
SHIPIT_SYSTEMD_UNITS=(
  shipit-updater.service
  shipit-updater.path
  shipit-restarter.service
  shipit-restarter.path
)

shipit_sync_systemd_units() {
  local src_dir="$1" unit_dir="$2"
  local unit src

  # Nowhere to install units (no such directory), or no privilege to (a manual
  # `bash deploy.sh` as a normal user): do nothing, quietly. Deciding on
  # writability rather than uid keeps this honest under sudo, containers, and
  # the test harness alike.
  if [ ! -d "$unit_dir" ] || [ ! -w "$unit_dir" ]; then
    return 0
  fi

  for unit in "${SHIPIT_SYSTEMD_UNITS[@]}"; do
    src="$src_dir/$unit"
    [ -f "$src" ] || continue
    # `! cmp -s` covers both "differs" and "not installed yet". It stays inside
    # the `if` condition: a bare `cmp … && continue` would return non-zero for
    # the very case we care about and trip the caller's `set -e`.
    if ! cmp -s "$src" "$unit_dir/$unit"; then
      # Copy to a sibling and rename, never straight onto the live unit: a plain
      # `cp` truncates the destination first, so a kill or a full disk mid-copy
      # would leave systemd with half a unit file. `mv` within the directory is
      # an atomic rename — the unit is either the old one or the new one.
      if cp "$src" "$unit_dir/.$unit.new" && mv "$unit_dir/.$unit.new" "$unit_dir/$unit"; then
        echo "==> Updated systemd unit $unit"
      else
        rm -f "$unit_dir/.$unit.new"
        echo "WARNING: could not install $unit into $unit_dir" >&2
      fi
    fi
  done

  # Reload UNCONDITIONALLY, not just when this run changed something. A reload
  # that failed (or was killed) on an earlier run leaves the files matching and
  # the manager still on the old config, and a `changed`-gated reload would then
  # never retry it — the new bounds would stay unapplied indefinitely. It is
  # idempotent and cheap, so the simplest way to be sure is to always ask.
  # Safe from inside the updater unit's own ExecStart: systemd keeps a running
  # job on the config it started with, so a new unit setting applies from the
  # NEXT activation.
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload \
      || echo "WARNING: systemctl daemon-reload failed; unit changes apply on the next reload." >&2
  fi
  return 0
}
