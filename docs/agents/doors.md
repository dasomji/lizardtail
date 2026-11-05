# Merge doors

Upgrade uncertain cases to one-way. Review behavior even when a file contains
both kinds of changes. No door classification authorizes production operations,
data deletion or secret changes by itself.

## One-way

- Manifest migration/backfill execution and data upgrades.
- Auth/grant/token behavior in `src/managed/tailscale-api.ts`, or permission and
  exposure changes through `--public` / `--funnel`.
- Production deploy/environment configuration and release deployment in
  `.github/workflows/publish.yml`.
- Destructive cleanup in `src/managed/resources.ts` or any path deleting data.
- Any newly introduced secret handling, regardless of filename.

## Two-way

Other preview lifecycle/container behavior in `src/managed/{cli,runtime,system,bridge,config}.ts`
and `src/index.ts` is two-way when `verify:app` covers it and reverting the change
undoes it. Documentation extraction can be two-way; actual migration/auth/data/
production operations upgrade the call. Do not classify whole mixed modules from
their filenames alone.

## Pilot opt-in

auto-merge: enabled

This G8 pilot marker becomes effective for later PRs only after Daniel merges
this document. It never enables auto-merge for this migration PR: Daniel reviews
and merges it in evidence mode. Merge policy reads doors and opt-in from refreshed
`origin/main`, never from the proposed PR head.
