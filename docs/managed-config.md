# Project and host configuration

`lizardtail.project.json` is checked into each project and inherited by worktrees.
Commands are arrays of arguments, not shell strings. Use the actual package
manager and framework's development mode. Example:

```json
{
  "version": 1,
  "project": "example",
  "envFiles": [".env"],
  "env": {"APP_URL": "${origin.app}"},
  "services": {
    "api": {
      "command": ["node", "--watch", "server.js"],
      "port": true,
      "env": {"PORT": "${port.api}"},
      "ready": {"path": "/health", "status": 200, "timeoutMs": 60000}
    },
    "web": {
      "command": ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "${port.web}", "--strictPort"],
      "port": true,
      "dependsOn": ["api"],
      "ready": {"path": "/"}
    }
  },
  "endpoints": {"app": {"routes": [
    {"path": "/api/*", "service": "api", "stripPrefix": true},
    {"path": "/", "service": "web"}
  ]}},
  "update": [["npm", "run", "build"]]
}
```

Services may set `cwd` relative to the project root, `envFiles` and `env`.
Dependencies must become ready first. Omit `port` for queue/watch workers; they
must remain running, not exit after a one-shot task. Readiness defaults to HTTP
200 at `/`; configure an exact redirect status when needed. Port ownership is
checked against the supervised process tree. Sustained HTTP failure withdraws
the preview; brief reloads have a 30-second grace period.

Routes are longest-prefix first; `/` is the catch-all. Prefix stripping is only
valid for `/prefix/*`; object storage must keep its URI unchanged. Endpoint
names produce independent HTTPS origins. Define a `storage` endpoint targeting
the reserved `storage` service when using managed buckets.

Optional database:

Match the source PostgreSQL major version before importing. For official PostgreSQL
18+ images set `volumePath` to `/var/lib/postgresql`; for 17 and earlier the default
is `/var/lib/postgresql/data`. Pin the image digest. Changing either the image or
mount of an existing database requires an explicit data upgrade.

```json
{"kind":"postgres","image":"postgres:17-bookworm@sha256:PINNED_DIGEST","source":"import","migrate":["pnpm","db:migrate"]}
```

`source: "import"` blocks starting main until its deliberate import completes.
Omit it only when a fresh main database is intended. `cwd` sets migration working
directory. SQLite uses `{"kind":"sqlite","source":"database/database.sqlite",
"migrate":["php","artisan","migrate","--force"]}` and copies the existing
main source using Python's backup API. Features always copy initialized main.

Optional storage: `{"image":"chrislusf/seaweedfs:4.45@sha256:PINNED_DIGEST"}`.
Never change a populated container's image in place; the runtime rejects that
change pending a deliberate database/storage upgrade.

Available substitutions in commands/environment:

- `${root}`, `${instance}`, `${port.SERVICE}`
- `${origin.ENDPOINT}`, `${hostname.ENDPOINT}`
- `${database.url}`, `${database.password}`, `${database.name}` (PostgreSQL)
- `${database.path}`, `${database.url}` (SQLite)
- `${storage.bucket}`, `${storage.accessKey}`, `${storage.secretKey}`
- `${storage.endpoint}`, `${storage.internalEndpoint}`

Managed `DATABASE_URL` always overrides dotenv values. Framework loaders must
not overwrite it later. Additional service environment overrides project env.
Secrets are held in private host state, never emitted by plan/status.

Host file `~/.config/lizardtail/host.json`:

```json
{
  "portMin": 20000,
  "portMax": 29999,
  "blockedPorts": [80,443],
  "exposure": "service",
  "dockerContext": "rootless",
  "caddy": "/home/dev/.local/bin/caddy"
}
```

`service` uses named Tailscale HTTPS Services. `port` is an explicit fallback
using stable high HTTPS ports on the machine hostname. `none` is loopback-only
for local integration tests. Optional `tailnet` sets the Service DNS suffix.
Changing configuration of a running instance requires `down` first. Changing a
reserved port is not automatic, because it would silently change framework
configuration/URLs: stop the foreign listener or deliberately migrate the
instance. Registry changes are serialized with `flock`.

`LIZARDTAIL_HOST_CONFIG` and `LIZARDTAIL_STATE_DIR` override the host file and
state directory for isolated tests. Keep the state path short enough for Unix
socket limits. The registry retains reservations after stop/finish; do not edit
it while services are running.
