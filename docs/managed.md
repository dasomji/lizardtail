# Managed worktree previews

Lizardtail's managed mode uses a project manifest, persistent central port registry,
systemd user supervision, Caddy routing and private Tailscale Services. It does not
infer service identity from terminal output. The legacy command wrapper is retained.

Requires Linux, Node.js 22+, `systemctl --user`, `flock`, `ss`, `curl`, Caddy and
Tailscale. PostgreSQL and SeaweedFS use a **rootless** Docker context. Run
`scripts/host-setup.sh` to prepare it; an administrator must install `uidmap` first
if `newuidmap`/`newgidmap` are missing. Never give agents the rootful Docker socket.

```bash
lizardtail init                       # starter manifest; adapt to actual framework
lizardtail plan --instance main       # once, in the dedicated main checkout
lizardtail db import --instance main --source-env-file /private/dev.env
lizardtail up --instance main
# In a feature worktree with the manifest:
lizardtail plan                       # stable worktree identity and reservations
lizardtail db migrate                 # clone main before schema changes
lizardtail up                         # survives the agent/terminal
lizardtail exec -- pnpm db:generate   # tools with the local instance environment
lizardtail status
lizardtail logs
lizardtail refresh                    # explicit build/collectstatic/restart workflow
lizardtail down                       # retains data and URL reservations
lizardtail finish --pr 123            # merged exact head, clean feature and main required
```

`db import` is only for an uninitialized PostgreSQL main. Verify the source is
**development** before invoking it. It copies data without changing the remote
source; it never deletes Neon branches. For local main initialized by migrations,
omit `database.source`; SQLite main requires an existing source file.

See [the manifest reference](managed-config.md) for commands and interpolation.
Register main in a clean dedicated checkout of the default branch, not whichever
feature branch happens to occupy the original repository directory. Plans print
intended URLs; only `up` plus remote verification establishes reachability.

Caddy provides ordered API path routing and WebSocket/HMR proxying, including
independent Laravel app/Vite origins. Each instance has its own proxy process and
per-run Unix sockets. A systemd user socket reserves each loopback gateway port and socket-proxyd
forwards it to the per-run Unix socket. This bridge is necessary because the
system Tailscale daemon restricts direct Unix targets to local administrators.
The gateway survives a supervisor crash and keeps the TCP port occupied until
route cleanup, preventing reassignment to another dev process. After host reboot,
the socket units rebind, but there is no guarantee about startup ordering relative
to unrelated system services; registry ports must stay dedicated to Lizardtail.
`down` removes only routes still pointing to this instance's recorded targets.
Do not globally reset Serve or prune Docker resources.

PostgreSQL copies use pg_dump/restore; SQLite uses its online backup API. A feature
gets independent data. Stopping containers retains volumes; restarting resumes
existing state. Finishing fetches/fast-forwards main, creates a private backup,
runs update actions/migrations and waits for supervised startup before deleting
feature resources. It does not merge feature data rows into main or remove Git
worktrees. Its journal is `finish.json` in the instance state directory. If main
fails, feature resources remain. Review main in the browser before removing the
feature worktree. Backups require deliberate retention management.

SeaweedFS uses a separate bucket store per instance. Feature initialization copies
main objects. Use the browser storage origin for presigning and the loopback
endpoint for server SDK operations. Caddy must preserve the signed path/Host;
CORS permits only the instance's configured application origins. GCS integrations
can remain cloud-backed and outside Lizardtail's cleanup ownership.

## Named Tailscale Services

Prepare `tag:lizardtail-host` for the serving node and `tag:lizardtail-preview` for
Service definitions. Preserve the host's existing SSH/network access when moving
from user ownership to tags. Configure grants and Service auto-approvers in the
Tailnet policy; project startup never edits global ACLs or retags the host.

Store an API token as `~/.config/lizardtail/tailscale-token` with mode 600. Managed
`up` creates missing Service definitions, marking ownership as `lizardtail:ID` and
refuses foreign definitions. `down` preserves them; `finish` removes owned
Services. A short-lived personal API token is suitable for bootstrap, but renewal
is required; it has broad API rights. Do not commit it or pass it on a command line.
Service definition creation, host advertisement approval and client access grants
are separate requirements. Local readiness cannot prove a different tailnet
client's access. Some Tailscale versions cannot hairpin to their own hosted
Services: use internal endpoints for backend traffic and test from another device.

## Checks

```bash
npm test
python3 scripts/smoke-managed.py       # disposable real systemd/Caddy multi-service test
node scripts/smoke-resources.mjs       # disposable PostgreSQL/S3 clone + proxy/CORS test
```

The smoke tests use pinned images and clean only their disposable resources.
Tailnet access is a separate host integration check. Also run
`node scripts/smoke-bridge.mjs` for socket reservation after upstream failure and
`python3 scripts/smoke-finish.py` for merged-PR/data cleanup gates.

For continuous API access, `tailscale-oauth.json` (mode 600, beside the host file)
can contain `{"clientId":"...","clientSecret":"..."}`. Lizardtail obtains and
renews short-lived tokens automatically; configure the client with the Services
permissions exposed by Tailscale. This file takes precedence over the bootstrap
API token. OAuth credentials are never forwarded into project environments.

Port 443 on a named Service is its own virtual endpoint; it does not replace
the machine's port 443. Existing Serve mappings, including their stale local
proxy destinations, are excluded from new allocations. Legacy mappings are not
automatically removed because their ownership cannot be established.

Managed app supervisors currently survive agent/logout, not host reboot. The
reserved gateway sockets persist; run `lizardtail up` to restart apps after reboot.
