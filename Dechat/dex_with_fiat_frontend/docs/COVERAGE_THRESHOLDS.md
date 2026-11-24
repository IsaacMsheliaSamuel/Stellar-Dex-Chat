# Critical module coverage thresholds

This frontend enforces coverage floors for the financial invariants that are
cheapest to regress and most expensive to debug: amount parsing, payout
transitions, authorization, contract client decoding/error mapping, and
status reconciliation.

## Scope

Coverage is measured by `vitest.coverage.config.ts`, which uses the module and
test lists in `scripts/critical-coverage-modules.mjs`.

| Category           | Source files                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| Amount parsing     | `src/lib/exactAmount.ts`, `src/lib/payout/minorUnits.ts`                   |
| Payout transitions | `src/lib/payout/payoutLifecycle.ts`                                        |
| Authorization      | `src/lib/auth/authorizationMatrix.ts`                                      |
| Contract client    | `src/contracts/encoding.ts`, `src/contracts/errorMapping.ts`               |
| Reconciliation     | `src/lib/payout/liabilityParity.ts`, `src/lib/transferStatusReconciler.ts` |

The config intentionally uses an empty `setupFiles` list so global legacy setup
cannot mask or break critical-module runs. Network-bound orchestration in
`src/contracts/client.ts`, ABI loading in `validateAbi.ts`, and provider-specific
webhook orchestration in `cancellationSaga.ts` are tracked by the regular test
suite but are outside these floors because they require external services or
currently import modules with unrelated pre-existing breakage on `main`.

## Thresholds

| Metric     | Floor |
| ---------- | ----: |
| Statements |   80% |
| Branches   |   70% |
| Functions  |   80% |
| Lines      |   80% |

Mutation score floor: **100%** for the curated invariant mutants in
`scripts/mutation-coverage.mjs`.

Thresholds are set slightly below the current measured baseline to remain
stable across non-deterministic test ordering while still failing on meaningful
loss of coverage. Do not lower a threshold to make a PR pass; add focused
regression tests instead.

## Commands

```bash
pnpm coverage:critical
pnpm coverage:critical:check
pnpm coverage:critical:mutation
BASE_REF=upstream/main pnpm coverage:critical:changed-lines
pnpm coverage:critical:report
```

- `coverage:critical` writes text, JSON, and JSON-summary reports to
  `coverage/critical/`.
- `coverage:critical:check` is the CI gate and fails if any threshold above is
  missed.
- `coverage:critical:mutation` applies deterministic source mutants one at a
  time, runs the focused test that should kill each one, restores every source
  file, and writes `coverage/critical/mutation-report.json`.
- `coverage:critical:changed-lines` compares added lines in critical source
  files against `BASE_REF` and fails if any changed line is not covered. It
  writes `coverage/critical/changed-lines-report.json`.
- `coverage:critical:report` combines the coverage, mutation, and changed-line
  reports into `critical-coverage-report.json` for the PR comment artifact.

## CI behavior

The `critical-coverage` job in `Frontend CI` runs the four commands above on
every PR that changes frontend code. It fetches the base branch so changed-line
reporting works for fork PRs. The coverage comment workflow reports the critical
metrics, mutation score, and uncovered changed-line count on the PR.

Failure-path tests are part of the floor. Examples currently required:

- Excess fractional digits and overflow must be rejected by amount parsing.
- Terminal payout states cannot transition to arbitrary statuses.
- Cross-user transfer reads are denied and do not reveal the record.
- Invalid receipt payloads return `null` instead of decoding.
- Host error strings still yield typed contract error codes.
- Delayed non-terminal updates cannot revert terminal reconciliation state.
- Non-authoritative provider responses cannot declare payout success.
