#!/usr/bin/env python3
"""Run focused security mutation tests for the FiatBridge contract.

Each curated mutant is a small, security-relevant source edit. The harness
applies one mutant at a time, runs the focused regression test that is supposed
to detect it, restores the source file, and records whether the test killed the
mutant. A mutant counts as killed only when the test binary fails; a compile
error or a surviving mutant fails the run.

No credentials or real user data are used: every fixture address is generated
by the Soroban test environment.
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

CONTRACT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_FILE = CONTRACT_ROOT / "src" / "lib.rs"
TEST_TARGET = "security_mutation_regressions"

COMPILE_ERROR_MARKERS = (
    "error: could not compile",
    "error: aborting due to",
    "error[E",
)
TEST_FAILED_MARKER = "test result: FAILED"


@dataclass(frozen=True)
class Mutant:
    id: str
    category: str
    description: str
    find: str
    replace: str
    test: str


MUTANTS = (
    Mutant(
        id="M01",
        category="ownership",
        description="require_admin no longer authenticates the configured admin",
        find="""            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
""",
        replace="""            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        Ok(admin)
""",
        test="admin_gated_entrypoint_rejects_missing_auth",
    ),
    Mutant(
        id="M02",
        category="signature validation",
        description="init no longer requires the admin signature",
        find="""    ) -> Result<(), Error> {
        admin.require_auth();
        Self::validate_and_increment_init_nonce(&env, &admin, nonce)?;
""",
        replace="""    ) -> Result<(), Error> {
        Self::validate_and_increment_init_nonce(&env, &admin, nonce)?;
""",
        test="init_rejects_missing_admin_signature",
    ),
    Mutant(
        id="M03",
        category="signature validation",
        description="check_nonce accepts a replayed (stale) nonce",
        find="""        if provided != current {
            if provided < current {
                return Err(Error::StaleNonce);
            } else {
""",
        replace="""        if provided != current {
            if provided < current {
                return Ok(());
            } else {
""",
        test="stale_payout_nonce_is_rejected",
    ),
    Mutant(
        id="M04",
        category="state transition",
        description="finalize_cancellation skips the Approved-state guard",
        find="""        if cancellation.status != CancellationStatus::Approved {
            return Err(Error::CancellationNotApproved);
        }
""",
        replace="""        if false {
            return Err(Error::CancellationNotApproved);
        }
""",
        test="finalize_cancellation_requires_approved_state",
    ),
    Mutant(
        id="M05",
        category="uniqueness",
        description="init no longer rejects duplicate multisig signers",
        find="""        for s in signers.iter() {
            if seen.contains(&s) {
                return Err(Error::DuplicateSigner);
            }
            seen.push_back(s);
        }
""",
        replace="""        for s in signers.iter() {
            seen.push_back(s);
        }
""",
        test="init_rejects_duplicate_signers",
    ),
    Mutant(
        id="M06",
        category="uniqueness",
        description="request_cancellation no longer rejects duplicate requests",
        find="""        if env
            .storage()
            .persistent()
            .has(&DataKey::CancellationRequest(request_id))
        {
            return Err(Error::CancellationAlreadyRequested);
        }
""",
        replace="",
        test="duplicate_cancellation_request_is_rejected",
    ),
)


def _exit_on_signal(signum: int, _frame: object) -> None:
    raise SystemExit(128 + signum)


for _signal in (signal.SIGINT, signal.SIGTERM):
    signal.signal(_signal, _exit_on_signal)


def cargo_test(test_filter: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["cargo", "test", "--test", TEST_TARGET, test_filter, "--", "--exact"],
        cwd=CONTRACT_ROOT,
        capture_output=True,
        text=True,
    )


def validate_mutants(original: str) -> None:
    for mutant in MUTANTS:
        occurrences = original.count(mutant.find)
        if occurrences != 1:
            raise SystemExit(
                f"{mutant.id}: expected exactly one source match, found {occurrences}"
            )
        if mutant.find == mutant.replace:
            raise SystemExit(f"{mutant.id}: mutation is a no-op")


def verify_baseline() -> None:
    result = subprocess.run(
        ["cargo", "test", "--test", TEST_TARGET],
        cwd=CONTRACT_ROOT,
        capture_output=True,
        text=True,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0 or TEST_FAILED_MARKER in output:
        raise SystemExit(
            "Baseline regression tests must pass before mutation testing:\n" + output
        )
    for mutant in MUTANTS:
        if f"test {mutant.test} ... ok" not in result.stdout:
            raise SystemExit(f"Baseline did not run {mutant.test} successfully")


def run_mutant(mutant: Mutant, original: bytes) -> tuple[str, str]:
    mutated = original.decode("utf-8").replace(mutant.find, mutant.replace, 1)
    SOURCE_FILE.write_text(mutated, encoding="utf-8")
    try:
        result = cargo_test(mutant.test)
    finally:
        SOURCE_FILE.write_bytes(original)

    output = result.stdout + result.stderr
    if result.returncode == 0:
        return "SURVIVED", output
    if any(marker in output for marker in COMPILE_ERROR_MARKERS):
        return "COMPILE ERROR", output
    if TEST_FAILED_MARKER in output:
        return "KILLED", output
    return "UNEXPECTED FAILURE", output


def print_report(results: list[tuple[Mutant, str]]) -> None:
    print("\nSecurity mutation report")
    print("-" * 108)
    print(
        f"{'ID':<5}{'CATEGORY':<22}{'STATUS':<18}{'KILLING TEST':<45}DESCRIPTION"
    )
    print("-" * 108)
    for mutant, status in results:
        print(
            f"{mutant.id:<5}{mutant.category:<22}{status:<18}"
            f"{mutant.test.split('::')[-1]:<45}{mutant.description}"
        )
    print("-" * 108)
    killed = sum(status == "KILLED" for _, status in results)
    print(f"{killed}/{len(results)} security mutants killed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutant", help="run only the mutant with this ID")
    parser.add_argument("--list", action="store_true", help="list curated mutants")
    parser.add_argument(
        "--validate",
        action="store_true",
        help="only verify that every mutation still matches the contract source",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="print cargo output for each mutant"
    )
    args = parser.parse_args()

    if args.list:
        for mutant in MUTANTS:
            print(f"{mutant.id} [{mutant.category}] {mutant.description}")
        return 0

    selected = MUTANTS
    if args.mutant:
        selected = tuple(m for m in MUTANTS if m.id == args.mutant)
        if not selected:
            raise SystemExit(f"Unknown mutant ID: {args.mutant}")

    if not SOURCE_FILE.is_file():
        raise SystemExit(f"Missing contract source: {SOURCE_FILE}")

    original = SOURCE_FILE.read_bytes()
    validate_mutants(original.decode("utf-8"))
    if args.validate:
        print(f"Validated {len(MUTANTS)} mutation pattern(s) against {SOURCE_FILE}")
        return 0
    verify_baseline()

    results: list[tuple[Mutant, str]] = []
    for mutant in selected:
        status, output = run_mutant(mutant, original)
        results.append((mutant, status))
        if args.verbose or status != "KILLED":
            print(f"\n=== {mutant.id} {mutant.description} [{status}] ===")
            print(output)

    print_report(results)
    return 0 if all(status == "KILLED" for _, status in results) else 1


if __name__ == "__main__":
    sys.exit(main())
