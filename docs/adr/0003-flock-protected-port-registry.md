# 0003: Flock-protected port registry

Status: Accepted, implemented.

## Context

Concurrent previews need stable assignments; a free-port probe alone cannot
reserve a port or prevent two cooperating starts selecting the same assignment.

## Decision

`src/managed/system.ts` uses an exclusive `flock` around managed CLI operations
and writes the JSON registry with a private temporary file plus atomic rename.
`cli.ts` preserves registered assignments, excludes reserved/blocked ports,
existing Serve targets and Linux's ephemeral outbound range, and probes both
loopback address families before new allocations. Default dedicated allocation
range: 20000–29999. Stop and finish retain reservations; conflicting listeners
cause refusal rather than silently moving a known endpoint.

## Consequences

No database dependency is needed for this single-user host registry. All cooperating
writers must take the same lock; internal module calls alone do not provide that
contract. This is not a host-wide network namespace: unrelated processes can race
a bind probe. Runtime listener checks and persistent gateway sockets provide
additional protection. Keep state paths short enough for Unix socket limits.

## Rejected alternatives

The original review proposed SQLite transactions; the implemented JSON registry
with a process lock is sufficient for this host's serialized managed operations.
Unlocked allocation or allocating afresh on resume would break concurrency or
stable URL guarantees. Do not treat this as coordination across Unix users.

## Source lineage

Extracted from retired `docs/architecture-review-2026-09-07.md` and
`docs/host-rollout-2026-09-07.md`; git history keeps both originals. The latter
records why the ephemeral range was excluded. See [managed configuration](../managed-config.md).
