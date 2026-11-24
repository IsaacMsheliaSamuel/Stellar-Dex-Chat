# Security Mutation Testing Guide

This guide describes the focused mutation suite for the security-critical parts
of `FiatBridge`: ownership checks, signature/nonce validation, state
transitions, and uniqueness checks.

Mutation testing deliberately breaks one guard at a time and checks that a
focused regression test fails. A mutant that leaves the test suite green is a
gap in the tests, not a harmless change.

## Layout

| Path | Purpose |
|------|---------|
| [`tests/security_mutation_regressions.rs`](../tests/security_mutation_regressions.rs) | Focused regression tests, one per curated mutant, plus happy-path setup |
| [`scripts/run_security_mutation_tests.py`](../scripts/run_security_mutation_tests.py) | Applies each source mutation, runs its test, restores the source, and prints a report |
| [`.github/workflows/contracts.yml`](../../../.github/workflows/contracts.yml) | Runs the harness in CI and gates the production-readiness job on it |

The tests are a standalone integration-test target rather than `#[cfg(test)]`
modules inside `src/lib.rs`. That keeps the mutation suite independent of the
large legacy unit-test modules while still exercising the public contract
client and the real on-chain guard logic.

## Why `rlib` is enabled

The crate is built as both `cdylib` and `rlib`:

```toml
[lib]
crate-type = ["cdylib", "rlib"]
```

`cdylib` is still the deployable WASM artifact. `rlib` is required so the
integration-test target can link the contract crate. This is a build-mode
change only; it does not alter contract behavior or the WASM ABI.

## Curated mutants

| ID | Category | Mutated guard | Killing test |
|----|----------|---------------|--------------|
| `M01` | ownership | `require_admin` stops calling `admin.require_auth()` | `admin_gated_entrypoint_rejects_missing_auth` |
| `M02` | signature validation | `init` stops requiring the admin signature | `init_rejects_missing_admin_signature` |
| `M03` | signature validation | `check_nonce` accepts a stale nonce | `stale_payout_nonce_is_rejected` |
| `M04` | state transition | `finalize_cancellation` skips the `Approved` guard | `finalize_cancellation_requires_approved_state` |
| `M05` | uniqueness | `init` stops rejecting duplicate signers | `init_rejects_duplicate_signers` |
| `M06` | uniqueness | `request_cancellation` stops rejecting duplicate requests | `duplicate_cancellation_request_is_rejected` |

Each test first exercises the normal path where practical, then asserts the
failure path. This prevents a broad mutant that simply breaks everything from
being counted as a meaningful kill.

## Running locally

From `Dechat/stellar-contracts`:

```bash
python3 -m py_compile scripts/run_security_mutation_tests.py
python3 scripts/run_security_mutation_tests.py --list
python3 scripts/run_security_mutation_tests.py --validate
python3 scripts/run_security_mutation_tests.py
```

`--validate` only checks that each configured mutation still matches exactly
one location in `src/lib.rs`. It is useful when a contributor has moved or
reformatted a guard but has not yet run the full suite.

The full run:

1. verifies that all six baseline regression tests pass;
2. applies one mutation to `src/lib.rs`;
3. runs only the corresponding test with `cargo test --test
   security_mutation_regressions <test> -- --exact`;
4. restores `src/lib.rs` from the original bytes, including on interruption;
5. classifies the result as `KILLED`, `SURVIVED`, `COMPILE ERROR`, or
   `UNEXPECTED FAILURE`.

The process exits `0` only when every selected mutant was killed. Use
`--mutant M03 --verbose` to focus on one mutant and inspect its Cargo output.

> Always run the harness from a clean worktree. It writes to `src/lib.rs`
> temporarily, and it restores the exact bytes it read at startup.

## Adding a mutant

1. Add a focused test to `tests/security_mutation_regressions.rs` that passes
   on the unmutated contract and fails when the guard is disabled.
2. Add a `Mutant` entry to `MUTANTS` in the harness. The `find` string must
   match exactly one location in `src/lib.rs`.
3. Run `python3 scripts/run_security_mutation_tests.py --validate`, then the
   full harness.
4. Update the table in this document.

Keep mutations minimal and security-relevant. A mutation that changes a
constant into a compile error does not demonstrate test strength.

## Fixtures and data hygiene

All addresses are generated with `Address::generate` or registered through the
Soroban test environment. No credentials, real account addresses, or
production fixtures are stored in the repository.
