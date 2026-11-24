"""Focused regression tests for tools/workflow_guard.py (issue #289)."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import workflow_guard as guard  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
PINNED_CHECKOUT = "3d3c42e5aac5ba805825da76410c181273ba90b1"
OTHER_CHECKOUT = "d3f86a106a0bac45b974a628896c90dbdf5c8093"

CLEAN_WORKFLOW = f"""\
name: Example
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1
"""


class WorkflowGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / ".github" / "workflows").mkdir(parents=True)
        self.write_policy({})

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_workflow(self, body: str, name: str = "example.yml") -> Path:
        path = self.root / ".github" / "workflows" / name
        path.write_text(body, encoding="utf-8")
        return path

    def write_policy(
        self, entries: dict[str, list[str]], schema_version: int = 1
    ) -> None:
        payload = {"schemaVersion": schema_version, "allowedWriteScopes": entries}
        (self.root / ".github" / "workflow-policy.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )

    def findings(self) -> list[guard.Finding]:
        return guard.audit_repository(self.root)

    def rules(self) -> list[str]:
        return [finding.rule for finding in self.findings()]

    # ------------------------------------------------------------------ normal
    def test_real_repository_passes_the_guard(self) -> None:
        self.assertEqual([], guard.audit_repository(REPO_ROOT))

    def test_clean_workflow_passes(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        self.assertEqual([], self.rules())

    def test_job_without_own_permissions_inherits_read_only_default(self) -> None:
        body = CLEAN_WORKFLOW.replace(
            "    permissions:\n      contents: read\n    steps:\n", "    steps:\n"
        )
        self.write_workflow(body)
        self.assertEqual([], self.rules())

    def test_read_all_top_level_is_accepted(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                "permissions:\n  contents: read\n", "permissions: read-all\n"
            )
        )
        self.assertEqual([], self.rules())

    def test_local_reusable_workflow_needs_no_sha(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                f"uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1",
                "uses: ./.github/workflows/shared.yml",
            )
        )
        self.assertEqual([], self.rules())

    def test_docker_action_with_digest_passes(self) -> None:
        digest = "a" * 64
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                f"uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1",
                f"uses: docker://alpine@sha256:{digest}",
            )
        )
        self.assertEqual([], self.rules())

    def test_allowlisted_job_write_scope_passes(self) -> None:
        body = CLEAN_WORKFLOW.replace(
            "      contents: read\n    steps:",
            "      contents: read\n      pull-requests: write\n    steps:",
        )
        self.write_workflow(body)
        self.write_policy(
            {".github/workflows/example.yml::build": ["pull-requests"]}
        )
        self.assertEqual([], self.rules())

    def test_block_scalar_content_is_not_parsed_as_yaml(self) -> None:
        body = CLEAN_WORKFLOW.replace(
            f"        uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1\n",
            "        run: |\n"
            '          echo "uses: evil/action@main"\n'
            "          permissions: write-all\n",
        )
        self.write_workflow(body)
        self.assertEqual([], self.rules())

    def test_json_output_is_machine_readable(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = guard.main(["--root", str(self.root), "--json"])
        self.assertEqual(0, code)
        self.assertEqual([], json.loads(stdout.getvalue()))

    # ----------------------------------------------------------------- failure
    def test_mutable_tag_action_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                f"uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1",
                "uses: actions/checkout@v7",
            )
        )
        self.assertIn("ACTION_UNPINNED", self.rules())

    def test_mutable_branch_action_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                f"uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1",
                "uses: dtolnay/rust-toolchain@stable",
            )
        )
        self.assertIn("ACTION_UNPINNED", self.rules())

    def test_docker_action_without_digest_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                f"uses: actions/checkout@{PINNED_CHECKOUT} # v7.0.1",
                "uses: docker://alpine:latest",
            )
        )
        self.assertIn("ACTION_UNPINNED", self.rules())

    def test_pin_drift_between_workflows_is_rejected(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        second = CLEAN_WORKFLOW.replace(PINNED_CHECKOUT, OTHER_CHECKOUT)
        self.write_workflow(second, name="second.yml")
        self.assertIn("ACTION_PIN_DRIFT", self.rules())

    def test_missing_top_level_permissions_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                "permissions:\n  contents: read\n", ""
            )
        )
        self.assertIn("PERMISSIONS_MISSING", self.rules())

    def test_write_all_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                "permissions:\n  contents: read\n", "permissions: write-all\n"
            )
        )
        self.assertIn("WRITE_ALL_FORBIDDEN", self.rules())

    def test_job_level_write_all_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                "    permissions:\n      contents: read\n",
                "    permissions: write-all\n",
            )
        )
        self.assertIn("WRITE_ALL_FORBIDDEN", self.rules())

    def test_top_level_write_scope_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                "permissions:\n  contents: read\n",
                "permissions:\n  contents: read\n  issues: write\n",
            )
        )
        self.assertIn("TOP_LEVEL_WRITE_FORBIDDEN", self.rules())

    def test_undeclared_job_write_scope_is_rejected(self) -> None:
        body = CLEAN_WORKFLOW.replace(
            "      contents: read\n    steps:",
            "      contents: read\n      pull-requests: write\n    steps:",
        )
        self.write_workflow(body)
        self.assertIn("WRITE_SCOPE_NOT_ALLOWLISTED", self.rules())

    def test_unknown_permission_scope_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace(
                "      contents: read\n    steps:",
                "      contents: read\n      fictitious: read\n    steps:",
            )
        )
        self.assertIn("PERMISSIONS_INVALID", self.rules())

    def test_invalid_permission_value_is_rejected(self) -> None:
        self.write_workflow(
            CLEAN_WORKFLOW.replace("      contents: read\n", "      contents: WRITE\n")
        )
        self.assertIn("PERMISSIONS_INVALID", self.rules())

    # ------------------------------------------------------------------ policy
    def test_policy_entry_for_missing_job_is_rejected(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        self.write_policy({".github/workflows/example.yml::missing": ["issues"]})
        self.assertIn("POLICY_STALE_ENTRY", self.rules())

    def test_policy_entry_for_unused_scope_is_rejected(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        self.write_policy({".github/workflows/example.yml::build": ["issues"]})
        self.assertIn("POLICY_STALE_ENTRY", self.rules())

    def test_policy_with_unsupported_schema_is_rejected(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        self.write_policy({}, schema_version=2)
        self.assertIn("POLICY_INVALID", self.rules())

    def test_malformed_policy_json_is_rejected(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        (self.root / ".github" / "workflow-policy.json").write_text(
            "{not valid json", encoding="utf-8"
        )
        self.assertIn("POLICY_INVALID", self.rules())

    def test_missing_policy_file_is_rejected(self) -> None:
        self.write_workflow(CLEAN_WORKFLOW)
        (self.root / ".github" / "workflow-policy.json").unlink()
        self.assertIn("POLICY_INVALID", self.rules())


if __name__ == "__main__":
    unittest.main()
