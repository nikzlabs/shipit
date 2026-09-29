#!/bin/sh
set -e

# Exports each /run/secrets/shipit-<NAME> file as NAME, byte for byte. The
# functions keep everything in positional parameters, so no variable of this
# script can overwrite a secret of the same name.

_shipit_refuse() {
  echo "secrets-entrypoint: $1" >&2
  exit 1
}

# $1 is a secret file and the rest are the files after it. Every file is read
# before any secret is set, so no secret can change how the others are read.
_shipit_deliver() {
  [ "$#" -gt 0 ] || return 0
  set -- "${1#/run/secrets/shipit-}" "$@"
  case "$1" in
    '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
      _shipit_refuse "$2 is not named after an environment variable" ;;
    # bash changes or drops these names without an error.
    PIPESTATUS | SHLVL | _ | BASH_ARGC | BASH_ARGV | BASH_LINENO | BASH_SOURCE)
      _shipit_refuse "secret $1 cannot be delivered, because the shell keeps that name for itself" ;;
  esac
  # $(...) removes trailing newlines, so cat's exit status is appended after a
  # "." and removed again. No multibyte encoding uses "." as a trailing byte.
  set -- "$(cat "$2"; printf '.%s' "$?")" "$@"
  case "$1" in
    *.0) ;;
    *) _shipit_refuse "secret $2 could not be read" ;;
  esac
  _shipit_deliver_rest "$@"
  # unset drops bash's special handling of names such as RANDOM.
  unset "$2" || :
  eval "export $2=\"\${1%.0}\"" || _shipit_refuse "secret $2 could not be set in this shell"
}

_shipit_deliver_rest() {
  shift 3
  _shipit_deliver "$@"
}

_shipit_deliver_all() {
  # ShipIt adds this wrapper only to a service that declares a secret.
  [ -f "$1" ] || _shipit_refuse "no secret file is readable under /run/secrets"
  _shipit_deliver "$@"
}

_shipit_deliver_all /run/secrets/shipit-*

exec "$@"
