# Contributing

Thanks for contributing to Dechat. This document covers the workflow for
changes that touch the Soroban smart contract interface and its generated
TypeScript client bindings, as well as the payout side-effect pipeline.

## Pinned build toolchain

The Rust and Stellar build toolchain is pinned in a single canonical place so
that CI, the devcontainer, and local setups all use identical versions. Do not
install floating or `latest` tool versions.

- `rust-toolchain.toml` — the Rust toolchain channel, the `wasm32-unknown-unknown`
target, and the `rustfmt` and `clippy` components.
- `toolchain-versions.toml` — the exact Stellar CLI and Soroban SDK versions
used to build and test the contract.

Before building, verify that your installed tools match the pinned manifest:

```sh
# from the repository root
make verify-toolchain
```

The verification step compares the installed `rustc`, `cargo`, `rustfmt`,
`cargo-clippy`, `stellar`, and Soroban SDK versions against the pinned
manifest. On a mismatch it exits non-zero and prints the expected and installed
versions so you can correct your environment. CI runs the same check, so a
version drift fails the build with the same message.

To update a pinned version, change the manifest (and `rust-toolchain.toml` for
Rust components) in a dedicated pull request and regenerate the bindings as
described below.

## Prerequisites

Before running any validation command, make sure the following tools are installed and available on your `PATH`:

- **Node.js** (LTS) and **npm** — used for the frontend, API contract tests, and cross-browser smoke suite.
- **Rust** and **Cargo** — used to build and test the smart contracts.
- **`wasm32-unknown-unknown` target** — install with `rustup target add wasm32-unknown-unknown`.
- **Playwright browsers** — install with `npx playwright install` (Chromium, Firefox, and WebKit are all required for the cross-browser smoke suite).
- **`cargo` tooling for Wasm size checks** — the contract validation stage reports Wasm size against documented thresholds.

Install JavaScript dependencies from the repository root before running any frontend or API checks:

```sh
npm ci
```

## Single validation command

All repository checks are driven from the root through a single validation command with scoped modes. The command runs each stage in order and **returns a nonzero exit code if any prerequisite is missing or any stage fails**. It never reports success when a stage was skipped due to a missing tool.

```sh
npm run validate -- <mode>
```

### Modes

| Mode | What it runs |
| --- | --- |
| `frontend` | Frontend lint, type checks, unit tests, and the API consumer contract tests. |
| `contracts` | Contract build, contract unit/regression tests, and the worst-case resource regression suite (CPU, memory, and Wasm size thresholds). |
| `full` | Everything in `frontend` and `contracts`, plus the cross-browser wallet and transaction UX smoke suite. |

Examples:

```sh
npm run validate -- frontend
npm run validate -- contracts
npm run validate -- full
```

### Exit behavior

- **Exit `0`** — every stage in the selected mode completed successfully and all documented thresholds were met.
- **Nonzero exit** — a prerequisite is missing, a stage failed, or a threshold was exceeded. The failing stage is printed to the console so you can reproduce it directly.

Run `full` before opening a pull request. If you are only touching one area, the scoped modes (`frontend` or `contracts`) are faster and are the same checks CI runs for that area.

## Contract resource regression tests

The `contracts` mode includes a regression suite that benchmarks each public contract entry point against the maximum supported queue size, signer count, and batch size. The suite fails when CPU instructions, memory, or compiled Wasm size exceed the documented thresholds. If you change contract logic, run this suite and confirm the thresholds still hold; if a threshold must change intentionally, update the documented values and call out the change explicitly in your pull request.

## Contract security mutation tests

Changes to admin authorization, signature or nonce validation, withdrawal execution, or the cancellation lifecycle should also be checked with the focused mutation suite:

```sh
make contracts-mutation
```

The harness temporarily edits `Dechat/stellar-contracts/src/lib.rs`, so run it from a clean worktree. See [Dechat/stellar-contracts/docs/MUTATION_TESTING.md](Dechat/stellar-contracts/docs/MUTATION_TESTING.md) for the curated mutants and instructions for adding new ones.

## API consumer contract tests

The `frontend` mode includes API consumer contract tests that validate route responses, error shapes, and status codes against the versioned OpenAPI schema. These tests cover malformed inputs and provider failures so that undocumented response drift is caught before merge. When you change an API route or its response shape, update the published schema and the corresponding tests together.

To run only the API contract tests locally:

```sh
npm run test:api-contract
```

## Cross-browser wallet and transaction UX smoke suite

The `full` mode runs a focused Playwright suite across **Chromium, Firefox, and WebKit**. It covers wallet connection, signature rejection, pending transaction recovery, and payout status. Browser-specific wallet mocks are isolated per browser project so a mock for one engine cannot mask a failure in another.

To run the smoke suite locally:

```sh
npx playwright install
npm run test:e2e:smoke
```

To run a single browser while iterating:

```sh
npm run test:e2e:smoke -- --project=chromium
npm run test:e2e:smoke -- --project=firefox
npm run test:e2e:smoke -- --project=webkit
```

## Fixtures and credentials

Do not add credentials, secrets, or real user data to fixtures. Use synthetic, deterministic test data only. Wallet mocks must not reference real accounts or keys.

## Adversarial evaluation corpus

The repository ships a **non-production** evaluation corpus for prompt
injection through quoted content: pasted text, links, markdown, and
tool-shaped strings. Its purpose is to verify that untrusted quoted content
cannot alter policy, invoke tools, or leak hidden prompt context.

### Corpus conventions

- Fixtures live alongside the evaluation harness and are clearly marked
  non-production. Never place real user data, credentials, or live tokens in
  fixtures — use synthetic placeholders only.
- Each case records the adversarial input, the expected safe behavior, and
  the category it exercises (pasted text, link, markdown, tool-shaped string).
- Cover boundary and failure cases: malformed tool-shaped strings, nested
  markdown, and encoded or obfuscated links.

### What the evaluation asserts

For every case, the harness must confirm the quoted content:

- does not change the active policy or system instructions,
- does not trigger tool invocation, and
- does not surface hidden prompt context in the response.

### Adding cases

When adding a case, include a focused regression test covering the normal
path plus the relevant failure, authorization, or recovery edge case. Keep
fixtures deterministic and free of secrets so the corpus can run in CI.

## Pull request checklist

Every pull request is prefilled with the [PR template](../.github/PULL_REQUEST_TEMPLATE.md).
Complete all sections that apply; a CI job (`PR Checklist Validation`) will
fail if required items are left unchecked when the corresponding paths change.

### Contract / ABI changes

- [ ] Contract interface changes include regenerated bindings.
- [ ] The CI drift check passes with no ABI diff.
- [ ] Breaking changes are documented and versioned as described above.
- [ ] Regeneration left unrelated files unchanged.
- [ ] Adversarial evaluation cases include focused regression tests and no
      real user data or credentials in fixtures.
