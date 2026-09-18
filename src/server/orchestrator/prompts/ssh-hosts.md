## SSH destinations

The user can grant this session one or more remote servers. **Every granted destination is a `Host` block in `~/.ssh/config`** — read that file to see which ones you have, then use the alias: `ssh prod 'df -h'`, `scp build.tar prod:/srv/`, `rsync -a dist/ prod:/srv/app/`. Plain `ssh user@host` and `git clone ssh://…` work too.

ShipIt holds the private key and signs for you; **it is not in the container and you cannot read it**. `~/.ssh` holds only the config, `known_hosts`, and a `.pub` file. If `~/.ssh/config` has no `Host` block, this session has no destination granted — ask the user to grant one in the session's settings rather than trying to add a key yourself.

Each destination is reachable only because it is granted: a non-granted host is blocked by the egress firewall, and ShipIt refuses to sign for it. Nothing is installed on the remote server and no agent or model credential is stored there — it only receives the commands you run. See /shipit-docs/ssh.md.
