# Verification contract

Run on Node.js 22+ after `npm ci`. Lizardtail is a CLI, with no application login
or application database of its own. L2/CI builds it, tests its public commands and
refuses an invalid manifest. Real fixture database migration and supervised boot
belong to L3 on Coolify, never GitHub CI.

| Rung              | Invocation                                                                                                                                                                                                                     | Coverage and budget                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| L0 · edit         | `npm run typecheck`; `npm run build && npx tsx --test tests/index.test.ts` (wrapper), `tests/managed.test.ts` (managed), or `tests/checks.test.ts`, `tests/verify-command.test.ts` and `tests/smoke-cleanup.test.ts` (tooling) | Focus the touched seam; build before tests that use `dist`.                                                                             |
| L1 · commit       | `npm run hooks:install` once; then normal `git commit`. Explicit rerun: `.githooks/pre-commit` or `npm run check:fast`                                                                                                         | Staged format, typecheck, build, related tests. Aim below 60 s. Duration is printed per run.                                            |
| L2 · review entry | `npm run check:full`                                                                                                                                                                                                           | Build, tracked-file Prettier check, every test, CLI `--help` success and invalid-manifest refusal. Budget 90 s on Coolify.              |
| L3 · functional   | `npm run verify:app`                                                                                                                                                                                                           | Build this checkout and all four disposable host journeys below. Allow 15 minutes per journey; prerequisite probes time out after 30 s. |
| L5 · CI           | GitHub Actions job `test`, running `npm ci` then `npm run check:full`                                                                                                                                                          | Ubuntu/Node 22, same L2 command. Never invokes L3. Observe the actual PR check; local results do not imply CI passed.                   |

`npm run lint` checks tracked supported first-party files with Prettier. Generated
lockfile, `dist`, dependencies, coverage, vendor and local evidence are excluded;
unsupported shell/Python files have no Prettier parser. The Plane block has range
ignore markers to preserve its required bytes. `npm run check:cli` runs only the
help/refusal checks against an already-built CLI. No script auto-formats or stages.

## Staging and related tests

Fast exports the index to a temporary directory outside the checkout. It shares
only installed `node_modules`; typecheck, compilation and tests use the exported
sources, package scripts and configuration, with independent Git metadata. The
hook bootstraps the npm command and standalone runner from the index as well,
so unstaged changes to either cannot alter that commit's checks. Git's hook/index
environment is stripped before running tools and nested fixtures.

Only staged file bytes are formatted. Unstaged edits can remain invalid and are
never overwritten, stashed or added. Deleted files have no bytes to format; type
checking and tests still run. Unsupported staged files still trigger the remaining
checks. A direct run with no staged diff checks all indexed files and all tests.

- `src/index.ts` or `tests/index.test.ts`: wrapper tests.
- `src/managed/**`: both wrapper and managed tests; the wrapper calls managed dispatch.
- `tests/managed.test.ts`: managed tests.
- Both groups: both suites. Renames include both old and new paths.
- Shared or unknown paths (including tooling), no changes or missing selected
  tests: every indexed test. An empty test selection fails.

The fixture Git integration tests prove bad staged formatting rejects a real
commit (including `git commit -a` and `git commit <path>`) with unchanged HEAD, staged type errors fail, successful partial staging
preserves live file/index bytes, and unstaged runner/package edits do not bypass
the hook. They also prove related-test selection and conflict preservation.

## Hook installation and undo

Run `npm run hooks:install` before relying on L1. The installer writes clone-local
`core.hooksPath=.githooks`, shared by linked worktrees. It refuses any different
effective hooksPath (including an explicitly empty value) or non-sample common-directory hook, including non-executable
hooks, without changing them or the config. Integrate existing hooks explicitly
and preserve their exit status; do not delete them to get past the check.

A pre-merge main checkout may lack the tracked executable hook. Installation warns
for every such worktree and still installs; L1 does not run there until its revision
includes `.githooks/pre-commit`. Rerun installation after adding worktrees to audit
coverage. To undo a fresh installation:

```bash
git config --local --unset core.hooksPath
```

Preserve a preexisting identical setting rather than removing someone else's
configuration. Installation is explicit; `prepare` continues to build only.

## Coolify functional prerequisites and journeys

Run L3 only on the provisioned Coolify Linux host. The runner refuses CI and
preflights executable `~/.local/bin/caddy`, Python 3.11+ (exception notes), `flock`, `ss`, `curl`,
`/usr/lib/systemd/systemd-socket-proxyd`, a reachable `systemctl --user` manager,
a successful disposable `systemd-run --user` command, and Docker context `rootless`
with actual rootless security options. The PostgreSQL and SeaweedFS image digests
in `scripts/smoke-resources.mjs` must already be available in that context. A missing
prerequisite fails clearly before fixtures start; it is not a passing skip.
Check missing-prerequisite refusals manually as part of L3. Automated L2/CI tests
invoke `verify:app` only with `CI=true` and assert its never-in-CI refusal.

The runner builds this checkout's `dist` and invokes, in order:

1. `python3 scripts/smoke-managed.py`: two isolated frontend/backend instances,
   routing, idempotent start, independent stop, stable resume and stopped refusal.
2. `node scripts/smoke-bridge.mjs`: real socket proxy, upstream failure, retained
   port reservation and idempotent release.
3. `node scripts/smoke-resources.mjs`: pinned rootless PostgreSQL/S3 resources,
   main-to-feature cloning, independent rows/objects, persistent resume, signed
   PUT/GET through Caddy and origin-limited browser CORS.
4. `python3 scripts/smoke-finish.py`: real Git/SQLite/systemd with fixture GitHub
   metadata; unmerged refusal, divergent main leaves the supervisor running,
   failed migration retains backup/feature data, successful finish preserves main
   rows, and finished-instance restart is refused.

Fixtures use temporary state/host config outside the checkout, exposure `none`
and isolated port ranges. Only their recorded/labeled resources are cleaned.
Cleanup failure fails the rung; the runner reports suppressed cleanup errors as
failures too. It attempts later journeys after an earlier journey fails, then exits
nonzero if any failed. Journey stdout/stderr stream as they arrive. A 15-minute
timeout sends SIGINT, allows 120 seconds for cleanup, then escalates to SIGTERM
and, after another 120 seconds, SIGKILL. Both Node smokes use the same cleanup
promise for SIGINT, SIGTERM and `finally`; repeated signals cannot run cleanup
twice, and an interrupted smoke exits nonzero. Cleanup duration is printed.
A Coolify SIGINT teardown measured 7.93 seconds for two PostgreSQL containers,
two S3 containers, four bridges and two supervisors. The 120-second grace leaves
margin for four serialized 10-second Docker stop deadlines and user-unit teardown;
it is a bounded grace, not a guarantee for an unresponsive host. Fixtures may be
retained if cleanup did not complete; inspect only the fixture’s recorded
resources. Never reset global Serve or prune Docker to repair a smoke.

Exposure `none` and local HTTP/Host-header checks prove host routing and failure
behavior, not client ACLs or tailnet reachability. This host may not hairpin to
its own named Service IP. Changed named-Service behavior additionally needs a
disposable preview checked from another tailnet client through the shared browser.
September's rollout results are historical, not proof for the current commit.

## Receipts and release contents

Append actual results to ignored `.kitchen/receipts.jsonl`, one JSON object per
rung run, with `rung`, `command`, full `sha`, `result`, UTC `time` and `note`
(including elapsed seconds and any limits). Record L1 against the new HEAD only
after a successful commit. Keep logs/evidence outside git; upload sanitized media
with `evidence put` when applicable. Carry receipts across a later docs-only commit
only with the original SHA and an explicit unaffected-rung reason. L4/L5/L6 belong
to the orchestrator; no local command implies review or merge approval.

Use `npm pack --dry-run` to inspect release contents after packaging changes.
Only `docs/managed.md` and `docs/managed-config.md` ship as docs; agent guides,
ADRs, out-of-scope records, work plans and fixture account examples must be absent.
Do not publish as a verification step.
