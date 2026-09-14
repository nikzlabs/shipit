# SSH destinations

The user can grant a session one or more remote servers. Once granted, you run commands on them with the ordinary tools — `ssh`, `scp`, `rsync`, `git` over SSH — and ShipIt authenticates for you.

## Finding what you have

**`~/.ssh/config` is the list.** Every granted destination is a `Host` block there:

```
Host prod
  HostName prod.example.com
  User deploy
  Port 22
  IdentityAgent /run/shipit/ssh-agent.sock
  IdentityFile ~/.ssh/prod.pub
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/known_hosts
  ForwardAgent no
```

So `ssh prod 'df -h'` works, and so do `scp build.tar prod:/srv/`, `rsync -a dist/ prod:/srv/app/`, and `git clone ssh://deploy@prod.example.com/srv/repo.git`. `SSH_AUTH_SOCK` is set in the environment every harness's shell tool and the terminal inherit, so the alias is a convenience rather than a requirement.

If `~/.ssh/config` contains no `Host` block, this session has no destination granted. Say so and ask the user to grant one in the session's settings (Session settings → SSH destinations). Do not try to add a key yourself — there is nothing you can add that ShipIt will sign with.

## What you cannot do

**You cannot read the private key.** It lives in the orchestrator's credential store and never enters this container: not in the compose file, not in a compose service's environment, not under `/credentials`, not in a settings read. `~/.ssh` holds the config, `known_hosts`, and a `.pub` file — public material only.

When `ssh` needs a signature it asks ShipIt, which signs only if all of the following hold:

- the destination is granted to **this** session;
- the connection really reached the server whose host key ShipIt recorded (the server proves this by signing the session identifier — no relay can fake it);
- the connection is not a forwarded agent;
- the thing being signed is an SSH public-key authentication request for that connection, as that destination's configured user.

Anything else is refused, and each attempt — signed or refused, with the reason — is one line in the orchestrator log. You will see a refusal only as `ssh` failing with "Permission denied (publickey)"; the reason is in the log, and the user can read it.

## Host keys

The first connection to a destination records the server's host key and shows its fingerprint in a card in the chat. Later connections require that key. If the server's key changes — a rebuild, a reinstall, or something worse — the connection is refused and a warning card says so. The user clears the recorded key in Settings → Integrations → SSH hosts; you cannot, and editing `known_hosts` will not help, because the signer never reads it.

## Reachability

A granted destination is added to this session's egress allowlist at grant time. A destination addressed by IP is added as a CIDR, because an IP literal issues no DNS lookup and so cannot be admitted by name. A host that is **not** granted is unreachable even if you know its address.

A **network-off sandbox** is the one deliberate exception to "no user host widens the policy": SSH grants are composed into its effective policy explicitly, so a sandbox with Network access off can still reach exactly its granted destinations and nothing else new.

## Limits worth knowing

- **Revoking a grant stops new authentications only.** A connection that already authenticated continues until it closes — the firewall accepts established flows.
- **ShipIt cannot limit what you do once the server accepts you.** Bound that on the server side with a restricted user or a forced command. The public line ShipIt shows the user carries `no-agent-forwarding,no-port-forwarding,no-X11-forwarding`.
- **Nothing is installed on the remote host** and no agent or model credential is stored there. It receives commands; that is all.
- **Local runtime mode is different.** When ShipIt runs with `RUNTIME_MODE=local` the agent is an in-process child of the orchestrator with no mount boundary, so "the key is out of reach" does not hold. Nor does it hold if a destination is the ShipIt host itself, which hands you a path to the store from the outside.
- **Tailscale SSH bypasses this.** A peer running Tailscale SSH authenticates the *node*, and every session looks like the ShipIt host node. Keep key-based `sshd` auth on peers and do not grant the ShipIt host node in Tailscale SSH policies.
