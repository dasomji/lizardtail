# 0002: Per-instance data isolation

Status: Accepted, implemented.

## Context

Feature work can write rows, sessions and objects even without a migration diff.
Parallel instances need to stop, resume and clean up without affecting main.

## Decision

`src/managed/resources.ts` provisions one rootless PostgreSQL container/volume per
instance, binding its database port to loopback. Initialize features from main
using `pg_dump`/restore; SQLite uses Python's online backup API into an independent
instance file. Storage uses a separate SeaweedFS store per instance and SDK object
copying. Existing feature state is resumed rather than recloned on every start.
Images are pinned by manifests; changing a populated image or PostgreSQL mount
requires an explicit data upgrade. Match the PostgreSQL source major version;
official 18+ images need `/var/lib/postgresql`, older images use the default
`/var/lib/postgresql/data`.

## Consequences

Copies cost time and space proportional to data. Database and object copies are
not an atomic combined snapshot. Instance labels bound Docker cleanup; stop keeps
volumes and finish removes only feature-owned data after main succeeds. External
cloud storage remains outside this ownership. Isolation prevents accidental shared
writes, not malicious access by another process under the same Unix user.

## Rejected alternatives

A shared PostgreSQL process with per-instance databases saves resources but adds
shared lifecycle/reference accounting. Thin clones require extra storage
infrastructure; the initial small development datasets did not justify it.
Never copy a live PostgreSQL volume as a logical clone or implicitly merge feature
rows into main. See [implicit main data sync](../out-of-scope/implicit-main-data-sync.md).

## Source lineage

Extracted from retired `docs/architecture-review-2026-09-07.md` and
`docs/host-rollout-2026-09-07.md`; git history keeps both originals. The rollout's
project-specific imports and dated passing claims are not part of this decision.
See [configuration](../managed-config.md) for the maintained manifest contract.
