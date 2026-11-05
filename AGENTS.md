# Lizardtail agent routing

Read [GLOSSARY.md](GLOSSARY.md) for domain terms and [README.md](README.md)
for the legacy CLI. Managed operation and manifest reference remain in
[docs/managed.md](docs/managed.md) and [docs/managed-config.md](docs/managed-config.md).

- [Development](docs/agents/development.md): CLI setup, isolated fixtures and host gotchas.
- [Verification](docs/agents/verify.md): exact rung commands and hook installation.
- [Doors](docs/agents/doors.md): merge boundaries and pilot policy.
- [ADRs](docs/adr/): implemented decisions and trade-offs.
- [Out of scope](docs/out-of-scope/): rejected behavior and reasons.

Managed mode runs on Linux in a systemd user session, with rootless Docker
(context `rootless`), Caddy and Tailscale. Named Services require a tagged host.
Keep fixture state outside the checkout; never globally reset Serve or prune Docker.

<!-- prettier-ignore-start -->

<!-- BEGIN PLANE PROJECT -->

## Plane project

- Workspace: Personal
- Workspace slug: personal
- Workspace ID: c51280e8-6121-4a07-b25a-244d6dc466b2
- Name: Lizardtail
- Identifier: LIZARDTAIL
- Project ID: 54fef1b5-7af9-47c5-9ae2-4377568a3d1f
- Plane URL: https://plane.audiopoesis.com/personal/projects/54fef1b5-7af9-47c5-9ae2-4377568a3d1f
<!-- END PLANE PROJECT -->

<!-- prettier-ignore-end -->
