# LIZARDTAIL-7 plan

Single-user merge marker in `docs/agents/doors.md` (KITCHEN-27, done; kitchen PR
dasomji/chefs-kitchen#25 merged as 5d75829). Review mode: evidence. KITCHEN-27's
sign-off (Plane comment 67ea75dd, ADR 0003) supplies per-PR G7 merge approval for
this PR once G3/G4 pass. The marker takes effect only after merge; this PR is
judged by the base `doors.md`, which has no valid marker.

Scope change 2026-11-07 (Plane comment eced7d4e): remove `auto-merge: enabled`;
do not enable `allow_auto_merge`.

## Chunk 1 — doors.md marker (implementer: Codex GPT-6.1 Sol)

- Outcome: `doors.md` carries the exact line `single-user: rollback-ok` and a
  `rollback:` line with lizardtail's real procedure (revert squash commit through
  the same gates, refresh the host's npm-linked main build, npm release recovery by
  fixed version or `npm deprecate`, never unpublish) and names the deploy-health
  check. `auto-merge: enabled` removed; "Pilot opt-in" text updated to the new
  rule; forced one-way classes kept (including public npm releases).
- Owned files: `docs/agents/doors.md` only.
- Dependencies: none (KITCHEN-27 Done).
- Status: pending.

## Gates

- L1 hook on commit; L2 `npm run check:full` on PR head.
- L3 skipped: no runtime behavior changes (spec acceptance names L1/L2 only).
- L4: one cross-family review (Codex GPT-6.1 Sol reviews if Claude-authored;
  Claude reviews GPT-authored) including door confirmation.
- Before merge: PR comment quoting the KITCHEN-27 sign-off; G3/G4 on exact head.

## Findings

- none yet
