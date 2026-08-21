# docs/262 req 17 — make a plugin's companion CLIs reachable from login shells.
#
# The worker appends /plugin-bin to its own PATH, and every process it spawns
# inherits that. But Codex runs each tool command as `bash -lc`, and Debian's
# /etc/profile *unconditionally overwrites* PATH with the system default — so
# without this snippet a plugin command worked for one backend and was
# `command not found` for another. That is exactly the backend-dependence
# docs/262 rules out for skills (req 22), and it would be no better here.
#
# APPENDED, never prepended, which is the same rule the worker follows: the
# collision check (req 20) already refuses to generate a wrapper whose name
# resolves anywhere else on PATH, so appending costs a surfaced command
# nothing — and if that check is ever wrong, the ordering means a plugin still
# cannot shadow `git`.
#
# The directory is fixed at build time (unlike the Node pin's, which depends on
# the repo), so there is no handoff file to read: an absent or empty directory
# simply contributes nothing.
#
# Installed as /etc/profile.d/11-shipit-plugin-bin.sh. Sourced by /etc/profile
# AFTER it has set PATH, which is what makes the append stick.

if [ -d /plugin-bin ]; then
  case ":$PATH:" in
    *":/plugin-bin:"*) ;;
    *) PATH="$PATH:/plugin-bin" ; export PATH ;;
  esac
fi
