# Developing Lizardtail

This repository is the CLI itself. Starting another product's preview is a
separate operation in that product's checkout, using its own manifest and owned
state. Do not start or refresh real product previews to test changes here.

## Setup

Use Node.js 22+ and `npm ci` (the prepare script builds the CLI). Python 3 is
needed for SQLite backup and functional fixtures. Managed mode needs Linux,
`systemctl --user`, `systemd-run`, `flock`, `ss`, `curl`, Caddy, Tailscale and
rootless Docker context `rootless`. Named Services require a tagged serving host
and separately approved advertisements/client grants; ordinary startup does not
edit global ACLs or retag the host. Never use the rootful Docker socket.

Run `npm run dev -- --help` for source execution, or `npm run build` followed by
`node dist/index.js --help`. See [verification](verify.md) for editing/commit/full
checks and hook installation. The [README](../../README.md) covers legacy wrapper
usage; [managed operation](../managed.md) and [manifest reference](../managed-config.md)
cover the lifecycle. Follow [doors](doors.md) before changing sensitive behavior.

## Disposable fixtures and host gotchas

Create fixture projects, databases and host configuration with `mktemp` outside
the checkout. Set both `LIZARDTAIL_STATE_DIR` and `LIZARDTAIL_HOST_CONFIG` for every
fixture process. Use `exposure: "none"`, a dedicated port range below Linux's
outbound ephemeral range, and Caddy at `~/.local/bin/caddy` on Coolify. Keep state
paths short for Unix sockets. The supplied `npm run verify:app` orchestrates these
fixtures; no product data belongs in a worktree.

The user systemd manager must be reachable and remain available for persistent
previews. App units survive terminal/logout, but restart apps with `up` after a
host reboot; socket reservations persist. A bound socket is not app readiness.
Never change a running instance's config without `down` first, or silently reuse
foreign listeners. Match PostgreSQL major version and volume mount before import;
a changed populated image/mount requires a deliberate data upgrade.

Use the framework's watch/HMR loop or explicitly build/refresh after edits.
A responding old build does not prove changes are visible. Browser code should
use the intended public origin; internal SDK/backend calls can use loopback.
Host hairpin and client ACL limits are in [verification](verify.md).

Cleanup only fixture-owned instance files, labeled containers/volumes and recorded
bridge units. Propagate cleanup failures; never globally prune Docker, reset
Tailscale Serve, delete another checkout or touch unowned legacy resources.

## Accounts

Lizardtail has no login model; do not add fake accounts to the CLI. Fixture apps
that need login use dev/test-only `admin@test.com`, `user@test.com` or
`<role>@test.com`, password `password`. Never use these credentials in production.
