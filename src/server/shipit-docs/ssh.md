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
- the connection really reached the server whose host key ShipIt recorded — the server proves this by signing the session identifier, which no relay can fake, and ShipIt recorded that key only after seeing it at the destination's address itself;
- the connection does not declare itself a forwarded agent;
- the thing being signed is an SSH public-key authentication request (plain or host-bound) for that connection, with this destination's key, as its configured user.

Anything else is refused. Every attempt that reaches the signer is one line in the orchestrator log, with the outcome and the reason for a refusal. Note what that does **not** cover: `ssh` offers a key unsigned first, so if the server has not been given this destination's public line it rejects the offer and no sign request is ever made — that failure is invisible to ShipIt and appears only as `ssh` failing with "Permission denied (publickey)".

## Host keys

The first connection to a destination records the server's host key and shows its fingerprint in a card in the chat. Before recording it, ShipIt looks at the destination's own address and port from the orchestrator and records the key only if the same key answers there. The record is made only once the whole request has passed every check, so a failed attempt cannot pin the wrong key.

**So a first connection can be refused even though everything in this container is correct.** If the address is wrong, the port is wrong, the server is down, or a firewall sits between ShipIt and the host, the check finds nothing and `ssh` fails with "Permission denied (publickey)"; a card in the chat says what ShipIt saw at the address. There is nothing to fix from here — tell the user which destination it was, and that ShipIt could not see that host key at its configured address. If the address itself is what is wrong, they correct it with **Edit** on the destination's row in Settings → Integrations → SSH hosts, which keeps this session's grant; a Tailscale peer added by its MagicDNS name is the usual case, and the tailnet IP is what works.

Two narrower causes of the same card. If the user edits the destination while a connection is authenticating, that connection is refused and the card says so; simply retry. And if the server holds several **ECDSA** host keys of different curves, ShipIt's check gets whichever curve the server prefers, so forcing another one with `HostKeyAlgorithms` cannot pin — the card shows both key types, and the fix is to let the connection use the default.

Later connections require that key, and it is enforced in two places. ShipIt writes it into `~/.ssh/known_hosts`, so a changed key usually makes **`ssh` itself** refuse with its own loud host-key warning before ShipIt is asked for anything. The signer refuses a mismatch too, and posts a warning card — that is the backstop for the case where `known_hosts` has been edited.

The user clears the recorded key with **Forget** in Settings → Integrations → SSH hosts, and editing the destination's address or port clears it too, since the pin belonged to the old endpoint. You cannot, and editing `known_hosts` will not help: the signer never reads it.

## Reachability

A granted destination is added to this session's egress allowlist at grant time. A destination addressed by IP is added as a CIDR, because an IP literal issues no DNS lookup and so cannot be admitted by name. A host that is **not** granted is unreachable even if you know its address.

A **network-off sandbox** is the one deliberate exception to "no user host widens the policy": SSH grants are composed into its effective policy explicitly, so a sandbox with Network access off can still reach exactly its granted destinations and nothing else new.

## Limits worth knowing

- **Revoking a grant stops new authentications, and closes the address to new connections.** A connection that already authenticated continues until it closes — the firewall accepts established flows.
- **ShipIt cannot limit what you do once the server accepts you.** Bound that on the server side with a restricted user or a forced command. The public line ShipIt shows the user carries `no-agent-forwarding,no-port-forwarding,no-X11-forwarding`.
- **Nothing is installed on the remote host** and no agent or model credential is stored there. It receives commands; that is all.
- **Local runtime mode is different.** When ShipIt runs with `RUNTIME_MODE=local` the agent is an in-process child of the orchestrator with no mount boundary, so "the key is out of reach" does not hold. Nor does it hold if a destination is the ShipIt host itself, which hands you a path to the store from the outside. Local mode may also have no `ssh-keyscan`, in which case no destination can record its first host key at all.
- **Tailscale SSH bypasses this.** A peer running Tailscale SSH authenticates the *node*, and every session looks like the ShipIt host node. Keep key-based `sshd` auth on peers and do not grant the ShipIt host node in Tailscale SSH policies.
