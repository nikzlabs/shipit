#!/bin/sh
set -e

# Exports each /run/secrets/shipit-<NAME> file as NAME, byte for byte. The
# functions keep everything in positional parameters, so no variable of this
# script can overwrite a secret of the same name.

_shipit_refuse() {
  echo "secrets-entrypoint: $1" >&2
  exit 1
}

_shipit_export() {
  set -- "$1" "${1#/run/secrets/shipit-}"
  case "$2" in
    '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
      _shipit_refuse "$1 is not named after an environment variable" ;;
    # bash changes or drops these names on exec without an error.
    PIPESTATUS | SHLVL | _)
      _shipit_refuse "secret $2 cannot be delivered, because the shell keeps that name for itself" ;;
  esac
  # unset drops bash's special handling of names such as RANDOM; PATH has none,
  # and cat is found through it. $(...) removes trailing newlines, so a "." is
  # read after the value and removed again; no multibyte encoding uses that
  # byte as a trailing byte.
  [ "$2" = PATH ] || unset "$2" || :
  { eval "$2=\"\$(cat \"\$1\" && printf .)\"" && eval "export $2=\"\${$2%.}\""; } \
    || _shipit_refuse "secret $2 could not be set in this shell"
}

_shipit_export_each() {
  while [ "$#" -gt 0 ]; do
    if [ -f "$1" ] && [ "$1" != /run/secrets/shipit-PATH ]; then _shipit_export "$1"; fi
    shift
  done
}

_shipit_export_each /run/secrets/shipit-*
# Last, so that a PATH secret cannot change which cat reads the other files.
if [ -f /run/secrets/shipit-PATH ]; then _shipit_export /run/secrets/shipit-PATH; fi

exec "$@"
