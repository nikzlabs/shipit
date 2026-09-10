# Login shells reset PATH; restore the worker's provisioned Node pin afterwards.
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
