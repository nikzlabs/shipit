# Login shells reset PATH. Append plugin commands so they cannot shadow system tools.
if [ -d /plugin-bin ]; then
  case ":$PATH:" in
    *":/plugin-bin:"*) ;;
    *) PATH="$PATH:/plugin-bin" ; export PATH ;;
  esac
fi
