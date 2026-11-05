# LIZARDTAIL-2 — kitchen layout migration (pilot)

Skill: migrate (kitchen `skills/migrate`, checklist included). Source plan:
kitchen `research/31-migration-dry-run-lizardtail.md` (dry run 2026-11-04 at
`442483e`). Review mode: **evidence**; Daniel reviews and merges. Signed off
2026-11-05. Temporary work file: deleted before merge.

## Scope record

- Origin `github.com/dasomji/lizardtail`; canonical path
  `/home/dev/Development/lizardtail`; default branch `main` (resolved once).
- Branch base: `62c5624` (origin/main). Worktree clean at start.
- Plane: workspace `personal` (`c51280e8-6121-4a07-b25a-244d6dc466b2`), project
  LIZARDTAIL (`54fef1b5-7af9-47c5-9ae2-4377568a3d1f`) validated with
  `get_project`; states Todo/In Progress/In Review/Done present; label
  `ready-for-agent` present. Ticket In Progress with dispatcher claim. No relations.
- T3 project on Coolify `bf644d8d-4272-4d00-ba7d-ca7ddf581f4a` (dry run).
- **Untracked `AGENTS.md` hold:** only in the main checkout
  `/home/dev/Development/lizardtail/AGENTS.md` (sha256 `ff81191f…7d1`,
  2026-09-30), content = Plane managed block only. Reconciliation: the tracked
  `AGENTS.md` reproduces that block byte-for-byte (values re-validated live), so
  the local file adds nothing. Never edit, move or delete it from this ticket;
  after merge, a pull in the main checkout will refuse to overwrite it, and Daniel
  decides whether to remove it (identical content).

## Memory coverage

- Coolify `~/.claude/projects/*/memory/`: no lizardtail-named or worktree-alias
  memory directory exists (56 memory dirs scanned by name).
- Other products' memories mention lizardtail (audionautiq-web, Harnesssssing
  dashboard, others). They belong to those products' migrations. The one
  lizardtail-relevant durable fact seen ("Named services require a tagged host")
  is already in `docs/managed.md` and `src/managed/cli.ts`; nothing to extract.
- Primary kitchen clone `/home/dev/Development/chefs-kitchen/memories/`: absent.
- Mac: unlinked, uninspected; no Mac-only memories known (follow-up only if found).
- Automatic memory is off (`autoMemoryEnabled: false`). No originals touched.

## Open work reconciliation

- LIZARDTAIL-1 (Backlog) questions DB ownership and Tailscale coupling in
  `finish`. ADRs record the _current_ implemented decision and link LIZARDTAIL-1
  as an open question; they must not pre-empt it.

## Chunks

| #   | Outcome                                                                                                                                                                                                                                | Owned files                                                                                                                                                                                                                                                                  | Depends on                                 | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------- |
| A   | Contracts & knowledge: lean `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`, ADRs extracted from the two dated docs, out-of-scope records, `docs/agents/development.md` + `doors.md`, README Node 22+ fix and links, retire the two dated docs | `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`, `docs/adr/**`, `docs/out-of-scope/**`, `docs/agents/development.md`, `docs/agents/doors.md`, `README.md`, `docs/managed*.md` (links only), dated docs (delete)                                                                      | —                                          | complete |
| B   | Verification contract: `lint`, `check:fast`, `check:full`, `verify:app`, pre-commit hook + installer, CI on `check:full`, npm `files` narrowing, formatting cleanup, `docs/agents/verify.md`                                           | `package.json`, `package-lock.json` (only if deps change), `scripts/check-*.mjs`, `scripts/verify-app.mjs`, `scripts/install-hooks.mjs`, `.githooks/**`, `.prettierignore`, `.gitignore`, `.github/workflows/test.yml`, `docs/agents/verify.md`, format-only edits elsewhere | A committed (formatting touches A's files) | todo     |

One implementer owns both chunks sequentially (shared files: formatting).
Then: L2 → verifier L3 on Coolify → one cross-family L4 → delete this
directory → file-pr.

## Findings tracked here

- Source inventory: README + managed/config guides = durable, retained; the two
  dated reports = mixed work records, durable rationale extracted into three ADRs,
  one rejection record and agent guides, then retired. LICENSE, executable sources,
  fixtures and workflows retained. No product files moved; only the main checkout's
  Plane block was read and reproduced byte-for-byte. Existing credential-location
  documentation in managed.md was retained unchanged per link-only scope; none was
  copied into new guides.
- Current code confirms managed readiness/port ownership, cgroup supervision,
  generation-specific bridges, target-matched cleanup, serialized registry,
  ephemeral exclusion, independent DB/S3 copies and safe fast-forward refusal.
  Rollout's initial uncommitted-state note is superseded by its post-merge section;
  historical app integrations, imports and test results are not current proof.
- Unresolved legacy-wrapper requirements from the architecture review remain in
  src/index.ts: --port does not configure the child listener; TCP readiness accepts
  foreign listeners; external allocation has no lock/reservation and explicit ports
  bypass collision checks; cleanup records only port/mode, not target generation;
  output inference settles once and Laravel/Vite remains special-cased; direct-child
  exit can bypass descendant kill; --bg routes have no persistent recovery;
  readServeConfig failures return null; child exit 0 overrides exposure failure.
  Orchestrator follow-up: make wrapper allocation/cleanup ownership-safe, reject
  unverifiable state, preserve exposure errors, and test descendant termination;
  document weaker heuristics or migrate users to managed mode. These are outside
  this documentation/tooling ticket; only LIZARDTAIL-1 currently exists in Plane.
- Other unimplemented proposals requiring orchestrator triage: copy/build resource
  budgets and visible usage (status lacks resource accounting), recorded snapshot
  provenance and coordinated concurrent clone/migration behavior, and explicit
  failure/current-build visibility. Acceptance: document the intended guarantees,
  add observable limits/provenance and disposable concurrency/failure proofs before
  claiming support. No Thin Clone/shared-DB implementation is implied by the ADRs.
- Host reboot auto-start is not a promised requirement (explicit historical
  non-decision); current manual up requirement is preserved. Actual OAuth-client
  renewal and second-client named-Service access were not proven by old host-local
  smokes and remain external verification limits, not copied passing claims.
- LIZARDTAIL-1 remains the sole existing open issue: DB ownership/Tailscale coupling
  in finish is linked as an open ADR question without changing behavior.
- Chunk A intentionally links forward to verify.md, delivered in B. No other scope
  deviations so far.

- L0: Node 22.22.2, npm ci/build and typecheck passed. Initial L1 is blocked
  until B delivers its contract; A is the required documentation bootstrap commit.
  Prettier range-ignore markers preserve the required Plane block's exact bytes.
