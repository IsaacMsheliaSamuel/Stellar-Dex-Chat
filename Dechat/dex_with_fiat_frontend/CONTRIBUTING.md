# Contributing

Thanks for helping improve the DEX with Fiat frontend. This guide covers local setup, the checks we run in CI, and how to keep our visual regression baselines healthy.

## Getting started

1. Install dependencies with your package manager of choice (the repo uses `pnpm`).
2. Copy `.env.example` to `.env.local` and fill in local-only values. Never commit real credentials or user data.
3. Start the dev server with `pnpm dev`.

## Checks before opening a PR

Run the applicable checks locally before pushing:

- `pnpm lint` — static analysis and style.
- `pnpm typecheck` — TypeScript contract checks.
- `pnpm test` — unit and integration tests.
- `pnpm test:e2e` — Playwright end-to-end and visual regression tests.
- `pnpm coverage:critical:check`, `pnpm coverage:critical:mutation`, and `pnpm coverage:critical:changed-lines` — coverage floors for critical financial modules. See [docs/COVERAGE_THRESHOLDS.md](docs/COVERAGE_THRESHOLDS.md).

If a check is not applicable to your change, note why in the PR description.

## Visual regression tests

Critical financial states are covered by Playwright screenshot tests so that regressions in layout, copy, or state handling are caught before merge. The covered states are:

- Wallet disconnected
- Stale quote
- Pending payout
- Failed payout
- Degraded RPC

Each state is captured across both the **mobile** and **desktop** viewport projects defined in `playwright.config.ts`. Volatile data (timestamps, wallet addresses, token amounts, transaction IDs) is masked in the tests so screenshots stay stable across runs and machines.

### Running visual tests

```bash
pnpm test:e2e -- --project=mobile
pnpm test:e2e -- --project=desktop
```

To update snapshots locally after an intentional UI change:

```bash
pnpm test:e2e -- --update-snapshots
```

### Updating baselines intentionally

Baselines should only change when the UI change is intentional and reviewed. When updating snapshots:

1. Confirm the diff is expected and limited to the states your change affects.
2. Run the update command above for both `mobile` and `desktop` projects.
3. Review the regenerated images in the PR diff — call out the intentional change in the PR description.
4. Do **not** commit snapshots that contain real user data, credentials, or unmasked volatile values. If a new dynamic field appears, add it to the mask list in the test rather than accepting an unstable baseline.
5. Get reviewer sign-off on the baseline change before merging.

If a snapshot fails unexpectedly, treat it as a potential regression first — investigate before reaching for `--update-snapshots`.

## Event compatibility fixtures

Every state-changing public contract method has a deterministic golden fixture that snapshots its emitted event topics and payload encoding. Fixtures live in `fixtures/events/golden_events.json` and are asserted by the contract regression tests, so any change to an event topic or payload field fails the check until the fixture is regenerated intentionally.

### Schema versioning

The fixture file carries an explicit `schemaVersion`. When you change an event topic or any payload field:

1. Bump `schemaVersion` in `fixtures/events/golden_events.json`.
2. Add a compatibility note to the PR description explaining the change, its impact on downstream consumers (indexers, API, UI), and any migration steps.
3. Regenerate the affected fixtures (see below) and review the diff — only the events you intentionally changed should move.

A fixture change without a `schemaVersion` bump, or a `schemaVersion` bump without a compatibility note, is treated as a failing check. Do not hand-edit encoded topics or payloads to make a test pass; regenerate from the contract instead.

### Regenerating fixtures

Regenerate the golden fixtures from the current contract build after an intentional event change:

```bash
pnpm fixtures:events -- --update
```

Review the regenerated `fixtures/events/golden_events.json` in the PR diff and confirm it contains no credentials or real user data — use deterministic, synthetic values only.

## Contract deployment manifest

Every contract deployment publishes a machine-readable manifest so operators and tooling can verify what is live without reading source. The manifest records the deployment `network`, the deployed Wasm `wasmHash`, the `contractId`, the contract `specVersion`, and the required `admin`/`oracle` configuration.

### Generating a manifest

Generate the manifest from the deployed artifact after a successful deploy. The generator derives the Wasm hash and contract ID from the artifact itself rather than accepting them by hand, so the manifest always reflects what was actually deployed:

```bash
pnpm manifest:generate -- --network testnet --artifact ./target/dex_with_fiat.wasm
```

Commit the generated manifest alongside the deployment record. Do not hand-edit `wasmHash`, `contractId`, or `specVersion` — regenerate instead.

### Validation

Before promoting a deployment, validate the manifest against the deployed artifact:

```bash
pnpm manifest:validate -- --manifest ./deployments/testnet.json --artifact ./target/dex_with_fiat.wasm
```

Validation fails when:

- The manifest `wasmHash` does not match the artifact's hash.
- The manifest `contractId` or `specVersion` is missing or inconsistent with the artifact.
- The manifest `network` does not match the deployment target network (cross-network configuration is rejected).
- Required `admin` or `oracle` configuration is absent.

A failed validation must block the deployment — never override it to force a promotion. If validation fails, regenerate the manifest from the correct artifact and network and re-run the check.

## Emergency pause and recovery drill

Operators should rehearse the emergency pause and recovery flow on a testnet or local network before relying on it in production. The drill is a repeatable simulation that pauses the contract, confirms that mutations are blocked while read-only views remain available, verifies that queued liabilities are preserved, and rehearses authorized recovery.

### Running the drill

Run the drill against a testnet or local network deployment (never against mainnet):

```bash
pnpm drill:pause-recovery -- --network testnet --manifest ./deployments/testnet.json
```

The drill uses the `admin` identity from the manifest to authorize pause and unpause. It does not accept or store credentials — sign with the operator's configured local key or wallet as usual.

### What the drill verifies

1. **Pause** — the authorized `admin` pauses the contract and the pause is observable in contract state.
2. **Blocked mutations** — state-changing calls (e.g. swaps, deposits, withdrawals, payouts) are rejected while paused.
3. **Available views** — read-only views (balances, quotes, queued liabilities) continue to return data while paused.
4. **Queued liabilities** — liabilities queued before the pause are preserved and remain visible; nothing is silently dropped.
5. **Authorized recovery** — the authorized `admin` unpauses the contract and mutations succeed again, with queued liabilities handled correctly.
6. **Unauthorized attempts** — pause and unpause calls from a non-admin identity are rejected, and the contract remains in its prior state.

### Failure handling

If any step fails, the drill exits non-zero and reports which step failed. Treat a failed drill as a blocker: do not promote a deployment whose pause/recovery drill does not pass. Investigate the failure and re-run the drill after fixing the underlying issue — never bypass the drill to force a promotion.

## Commit and PR conventions

- Keep changes scoped to the issue you are solving.
- Write clear commit messages describing the behavior change.
- Include tests for new behavior, including failure and recovery paths where relevant.
- Update documentation when behavior, APIs, or operational procedures change.
