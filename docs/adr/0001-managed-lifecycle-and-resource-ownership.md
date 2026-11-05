# 0001: Managed lifecycle and resource ownership

Status: Accepted, implemented.

## Context

Log inference in the retained command wrapper cannot describe dependencies or
prove listener ownership. Parallel worktrees need independent lifecycles and
cleanup that preserves foreign routes and resources.

## Decision

Use a declarative project manifest and a persistent project/instance plan.
`src/managed/cli.ts` serializes managed operations through `system.ts`; `runtime.ts`
supervises native app processes in systemd user services, checks readiness and
listener ownership, and renders Caddy routes. Per-run Unix sockets and systemd
socket bridges retain the gateway port after upstream failure. Named Tailscale
Services require a tagged host; host-port and loopback exposure remain explicit
alternatives.

`down` compares current route targets with recorded targets before removal,
stops owned bridges/processes and retains data and reservations. Docker cleanup
checks instance labels; Service definitions have ownership markers. `finish`
requires a merged exact PR head and clean feature/main checkouts, verifies safe
fast-forward before stopping main, backs up and updates main, checks startup,
then removes feature resources and journals progress. It does not delete worktrees.

## Consequences

The host needs Linux user-systemd, Caddy and Tailscale setup. A process start is
not readiness, and loopback readiness does not prove remote client access.
Supervisors survive terminal/logout, but apps require `up` after reboot; reserved
socket units persist. Existing foreign/legacy routes are left alone.

Open question: [LIZARDTAIL-1](https://plane.audiopoesis.com/personal/projects/54fef1b5-7af9-47c5-9ae2-4377568a3d1f/work-items/e8c00a8e-9806-4ec1-a858-9b94c3b95a4e)
questions database ownership and Tailscale coupling in `finish`. This record
captures the current implementation; it does not decide that ticket's outcome.

## Rejected alternatives

Do not use log-selected ports as the managed identity or globally reset routes
and prune volumes during cleanup. Containerizing every app just for stable links
was unnecessary; native development processes retain their framework watch loops.
The legacy wrapper remains available with a weaker contract.

## Source lineage

Extracted from retired `docs/architecture-review-2026-09-07.md` and
`docs/host-rollout-2026-09-07.md`; git history keeps both originals. Proposals and
historical host/test state are not current evidence. See [managed operation](../managed.md)
and [verification](../agents/verify.md) for maintained behavior and fresh proof.
