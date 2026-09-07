# Host rollout, 7 September 2026

Managed previews are running as user `dev` on Coolify. Rootless Docker, Caddy,
systemd user supervision and named Tailscale Services are configured. The user
verified Better USC's named URL from another tailnet device. This host cannot
hairpin to its own Service IP, so other checks use the actual loopback gateway
with the public Host header. That does not independently verify client ACLs.

| Project | Registered main checkout | Browser URL |
| --- | --- | --- |
| audionautiq | `/home/dev/Development/lizardtail-main/audionautiq-web` | https://audionautiq-main-app-bafc0140.tailf5ea68.ts.net |
| better-usc | `/home/dev/Development/lizardtail-main/better-usc` | https://better-usc-main-app-6614cc9f.tailf5ea68.ts.net |
| me-tracker | `/home/dev/Development/me-tracker` | https://me-tracker-main-app-3682f143.tailf5ea68.ts.net |
| t5-laravel | `/home/dev/Development/lizardtail-main/t5-laravel` | https://t5-laravel-main-app-9570edf2.tailf5ea68.ts.net |
| BuDoBase | `/home/dev/Development/BuDoBase` | https://budobase-main-app-c78383bd.tailf5ea68.ts.net |

Audionautiq's verified Neon development branch was imported into PostgreSQL 17
(119 MB, 67 public tables). GCS remains unchanged. Better USC's previous local
PostgreSQL database was imported into its own PostgreSQL 17 container; SeaweedFS
provides its new isolated bucket. Both Laravel projects use private SQLite copies.
BuDoBase's user-approved Neon development database was imported into PostgreSQL 18
(11 MB, 40 public tables). The initially created PostgreSQL 17 destination was
verified empty and uninitialized before removing only those failed-import resources.
The PostgreSQL 18 volume mounts `/var/lib/postgresql`. Remote databases were not
deleted or modified by these imports.

BuDoBase's Django autoreloader is active. Its readiness path is `/login/`, because
`/` intentionally redirects unauthenticated users. Frontend build and collectstatic
completed; login, compiled JavaScript and CSS returned HTTP 200 through its gateway.
Run `lizardtail refresh` for React/CSS changes; Python changes use autoreload.

Verification covers:

- Two concurrent managed instances with separate frontend/backend services,
  correct routing, idempotent startup, independent shutdown and stable resume.
- PostgreSQL feature cloning and row isolation, persistent stop/resume, S3 object
  cloning, browser CORS and signed PUT/GET through Caddy.
- Signed PUT/GET through Better USC's actual socket bridge, Caddy and SeaweedFS,
  preserving its public storage hostname; the temporary test object was deleted.
- Laravel login pages, remote Vite origins and HMR WebSocket handshakes.
- Socket reservation after upstream failure and idempotent owned-route cleanup.
- Merged-PR cleanup using real Git/SQLite/systemd and mocked GitHub PR metadata:
  unmerged refusal, failed-main migration preserving feature data and backup,
  successful cleanup preserving main rows, and no restart of a finished instance.
- Current Herdr CLI smoke check and corrected optional log-pane commands.
- Lizardtail automated tests, audionautiq's local DB/worktree script tests, and
  generated skill validation/tests in `pi-daniel/pi-skills`.

A test exposed an occupied Docker port in Linux's ephemeral outbound range.
New allocations now exclude the host's `/proc/sys/net/ipv4/ip_local_port_range`
as well as blocked ports, registry reservations, listeners and existing Serve
targets. The default dedicated range is 20000–29999. Disposable smoke tests use
separate ranges below the host's ephemeral range.

The Tailnet ACL change added only Lizardtail tag ownership, Service auto-approval
and SSH access equivalent to the user's previous access to this host. Existing
grants and SSH rules remain. A private rollback policy and API evidence live in
`~/.local/state/lizardtail/tailscale-setup/`. Credentials and database dumps are
private host state, not repository content. Existing legacy services were retained
because their ownership was not established.

Source changes are currently uncommitted across Lizardtail, the project checkouts
and pi-skills. They have not been published as a plugin release; installed pinned
plugin caches still contain the previous skills. Updated sources and generated
Claude/Codex skills are in `Development/pi-daniel/pi-skills`. Commit/merge the
project integrations before relying on new Git worktrees inheriting manifests or
using the clean-main gate of `finish`. The linked local Lizardtail CLI is active.

App supervisors survive agent exit and logout, but require `lizardtail up` after
a host reboot. Gateway socket reservations persist. The bootstrap Tailscale API
token requires renewal; optional OAuth client credentials are supported but were
not provisioned or tested against a real OAuth client in this rollout.
