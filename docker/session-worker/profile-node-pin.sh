# docs/248 — re-apply the repo's pinned Node inside login shells.
#
# The worker puts the pinned toolchain's bin/ first on its own PATH, and every
# process it spawns inherits that. But Codex runs each tool command as
# `bash -lc`, and Debian's /etc/profile *unconditionally overwrites* PATH with
# the system default — so without this snippet a login shell silently dropped
# back to the image's Node while the terminal and the diagnostics panel both
# reported the pinned one. That is precisely the invisible mismatch
# nikzlabs/shipit#1728 is about, so it must not survive here.
#
# The worker writes the path at provisioning time (it can't be known at build
# time — it depends on the repo) and removes the file when no pin is active, so
# an absent or empty file correctly means "nothing to do".
#
# Installed as /etc/profile.d/10-shipit-node.sh. Sourced by /etc/profile AFTER
# it has set PATH, which is what makes the prepend stick.

if [ -r /session-state/node-bin ]; then
  _shipit_node_bin=$(cat /session-state/node-bin 2>/dev/null)
  if [ -n "$_shipit_node_bin" ] && [ -x "$_shipit_node_bin/node" ]; then
    case ":$PATH:" in
      *":$_shipit_node_bin:"*) ;;
      *) PATH="$_shipit_node_bin:$PATH" ; export PATH ;;
    esac
  fi
  unset _shipit_node_bin
fi
