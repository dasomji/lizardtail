# Merge doors

Upgrade uncertain cases to one-way. Review behavior even when a file contains
both kinds of changes. No door classification authorizes production operations,
data deletion or secret changes by itself.

## One-way

The single-user rule below covers only the named configuration/adoption classes.
All other one-way changes below still require Daniel's per-PR G7 approval.

- Manifest migration/backfill execution and data upgrades.
- Auth/grant/token behavior, including `src/managed/tailscale-api.ts`, or
  permission and exposure changes through `--public` / `--funnel`.
- Production infra/deploy/environment and deploy policy/configuration, including
  `.github/workflows/publish.yml`, remain one-way. The marker covers this
  configuration only when the merge itself publishes nothing; public npm
  releases (pushing a `v*` tag / running `publish.yml`) still need Daniel's
  per-PR approval.
- Destructive cleanup in `src/managed/resources.ts` or any path deleting data.
- Secret changes or any newly introduced secret handling, regardless of filename.
- Spend and anything other people use, including public contracts and releases.
- Merge/verification authority: this file's rules/markers, or removing, skipping
  or weakening checks, hooks, CI or branch protection.

## Two-way

Other preview lifecycle/container behavior in `src/managed/{cli,runtime,system,bridge,config}.ts`
and `src/index.ts` is two-way when `verify:app` covers it and reverting the change
undoes it. Documentation extraction can be two-way; actual migration/auth/data/
production operations upgrade the call. Do not classify whole mixed modules from
their filenames alone.

## Single-user merge approval

single-user: rollback-ok
rollback: Open a revert PR of the squash commit (`git revert <squash-sha>` on a
recovery branch), verify L1/L2 and CI `test`, then squash-merge through G3/G4 with
`--match-head-commit <head>`; refresh and rebuild the host's linked main checkout
as described below.

Daniel's 2026-11-06 KITCHEN-27 sign-off, amended 2026-11-07, is recorded in
chefs-kitchen ADR 0003 (`docs/adr/0003-single-user-merge-approval.md`). The marker
lets the owning work thread merge covered PRs: two-way PRs and one-way PRs whose
only one-way classes are production infra/deploy/env configuration, deploy
policy/configuration or migrate-skill (kitchen adoption). It does not downgrade
their door or authorize production operations. After merge G3/G4 pass, covered
PRs may merge regardless of review mode; evidence/try-it still deliver evidence
or a Lizardtail link. An explicit no-merge instruction or "Daniel merges this PR"
wins.

GitHub auto-merge is never used. The owning work thread squash-merges covered PRs
itself after G3/G4 on the exact head with `--match-head-commit <head>`. Use branch
protection where available; record missing protection as a limitation.

The marker takes effect only once this document is on `origin/main`, with
Daniel's recorded per-PR G7 approval for rules/marker changes. Merge policy reads
doors, markers and gates from refreshed `origin/main` (and the base merge skill),
never the PR head. A PR is never judged by the marker or rules it changes.

## Deploy health and rollback

Merges to main do not deploy or publish. G6's deploy-health check is the
default-branch CI run of workflow `Test`, job `test` (`npm ci` then
`npm run check:full`, as in [verification L5](verify.md)), reaching success on the
merge commit, plus `lizardtail --help` succeeding from the refreshed host build.

The host's global `lizardtail` is `npm link`ed: its bin symlinks to
`<main checkout>/dist/index.js` (currently `/home/dev/Development/lizardtail` on
this host). After a merge or rollback revert merges, refresh that checkout on
main with `git pull --ff-only`, then run `npm ci` (prepare builds `dist`), or
`npm run build` with dependencies already installed. Confirm `lizardtail --help`
succeeds. A code revert alone does not refresh this build.

`publish.yml` publishes only on `v*` tags. After an approved npm release, confirm
publishing succeeded; recovery publishes a fixed version or uses `npm deprecate`,
never `npm unpublish`.
