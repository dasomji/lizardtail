# Implicit main data sync

Feature rows and objects are never implicitly merged into main. `finish` applies
merged code, update commands and migrations to main's existing development data;
it does not replace main with the feature copy. A refresh/import is a separate,
deliberately approved operation. Production syncs require explicit authorization
and are outside this preview lifecycle.

A feature can contain temporary destructive experiments and test data. Copying it
back would lose main writes and bypass migration/backup review. Likewise, shared
cloud assets are not owned merely because a local instance references them.

This rejection comes from retired `docs/architecture-review-2026-09-07.md` and
`docs/host-rollout-2026-09-07.md`, retained in git history. Current evidence:
`src/managed/resources.ts` clones main into new feature resources and
`src/managed/cli.ts` updates main before cleaning features. See
[data isolation](../adr/0002-per-instance-data-isolation.md),
[lifecycle ownership](../adr/0001-managed-lifecycle-and-resource-ownership.md) and
[operator contract](../managed.md).
