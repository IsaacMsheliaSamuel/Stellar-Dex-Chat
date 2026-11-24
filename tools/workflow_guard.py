#!/usr/bin/env python3
"""Audit GitHub Actions workflows for least privilege and immutable action pins.

The check is deliberately dependency-free (Python standard library only) so it
can run in CI and on contributor machines without installing anything:

    python3 tools/workflow_guard.py
    python3 tools/workflow_guard.py --root . --json

Rules enforced
--------------
1. Every workflow declares a top-level ``permissions`` block.  Workflows with
   no block inherit the repository default, which may be write-capable.
2. ``permissions: write-all`` is never allowed.  Top-level write scopes are
   rejected; write scopes must be narrowed to the job that needs them and
   recorded in ``.github/workflow-policy.json``.
3. Every third-party ``uses:`` reference is pinned to a 40-character commit
   SHA.  Mutable tags/branches are rejected.  Local reusable workflows are
   allowed, and ``docker://`` images must carry a ``@sha256:`` digest.
4. An action may not be pinned to two different SHAs in the same repository.

Exit codes: 0 = clean, 1 = findings, 2 = usage/IO error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

KNOWN_SCOPES = frozenset(
    {
        "actions",
        "attestations",
        "checks",
        "contents",
        "deployments",
        "discussions",
        "id-token",
        "issues",
        "models",
        "packages",
        "pages",
        "pull-requests",
        "repository-projects",
        "security-events",
        "statuses",
    }
)
READ_VALUES = frozenset({"read", "none"})
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DOCKER_RE = re.compile(r"^docker://\S+@sha256:[0-9a-f]{64}$")
ACTION_RE = re.compile(r"^(?P<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@(?P<ref>\S+)$")
KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$")
USES_RE = re.compile(r"^(?:-\s*)?uses:\s*(.+)$")
PERM_ENTRY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):\s*([A-Za-z-]+)\s*$")


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str
    message: str

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "line": self.line,
            "rule": self.rule,
            "message": self.message,
        }

    def render(self) -> str:
        return f"{self.path}:{self.line}: {self.rule}: {self.message}"


@dataclass
class Permissions:
    line: int
    value: str = ""  # read-all / write-all / unknown scalar
    scopes: dict[str, str] = field(default_factory=dict)


@dataclass
class Job:
    name: str
    line: int
    permissions: Permissions | None = None


@dataclass
class Workflow:
    path: str
    is_workflow: bool
    top_permissions: Permissions | None
    jobs: dict[str, Job] = field(default_factory=dict)
    uses: list[tuple[int, str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class LogicalLine:
    line: int
    indent: int
    body: str
    comment: str


def split_comment(text: str) -> tuple[str, str]:
    """Split a YAML line into (content, inline comment), respecting quotes."""
    quote = ""
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = ""
        elif char in ("'", '"'):
            quote = char
        elif char == "#" and (index == 0 or text[index - 1].isspace()):
            return text[:index].rstrip(), text[index + 1 :].strip()
    return text.rstrip(), ""


def logical_lines(text: str) -> list[LogicalLine]:
    """Return meaningful YAML lines, skipping block-scalar bodies.

    Workflow ``run: |`` and ``script: |`` blocks contain shell or JavaScript
    that can mention ``uses:`` or ``permissions:``; treating those as YAML
    would create false findings.
    """
    result: list[LogicalLine] = []
    block_indent: int | None = None
    for number, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if block_indent is not None:
            if indent > block_indent:
                continue
            block_indent = None
        body, comment = split_comment(raw.strip())
        if not body:
            continue
        result.append(LogicalLine(number, indent, body, comment))
        if re.search(r":\s*[|>][+-]?\s*$", body):
            block_indent = indent
    return result


def parse_permissions(
    lines: Sequence[LogicalLine], index: int, inline: str, indent: int
) -> tuple[Permissions, int]:
    """Parse a permissions block starting at ``lines[index]``."""
    permissions = Permissions(line=lines[index].line)
    stripped = inline.strip()
    if stripped:
        if stripped in ("read-all", "write-all"):
            permissions.value = stripped
        elif stripped not in ("{}", "{ }"):
            permissions.value = stripped
        return permissions, index + 1

    cursor = index + 1
    while cursor < len(lines) and lines[cursor].indent > indent:
        match = PERM_ENTRY_RE.match(lines[cursor].body)
        if match:
            permissions.scopes[match.group(1)] = match.group(2)
        cursor += 1
    return permissions, cursor


def parse_workflow(path: str, text: str, is_workflow: bool) -> Workflow:
    lines = logical_lines(text)
    top: Permissions | None = None
    jobs: dict[str, Job] = {}
    uses: list[tuple[int, str, str]] = []

    for logical in lines:
        match = USES_RE.match(logical.body)
        if match and logical.indent > 0:
            uses.append((logical.line, match.group(1).strip(), logical.comment))

    index = 0
    while index < len(lines):
        logical = lines[index]
        key_match = KEY_RE.match(logical.body) if logical.indent == 0 else None
        if not key_match:
            index += 1
            continue
        key, inline = key_match.groups()
        if key == "permissions":
            top, index = parse_permissions(lines, index, inline, logical.indent)
            continue
        if key == "jobs":
            cursor = index + 1
            while cursor < len(lines) and lines[cursor].indent > 0:
                if lines[cursor].indent != 2:
                    cursor += 1
                    continue
                job_match = KEY_RE.match(lines[cursor].body)
                if not job_match:
                    cursor += 1
                    continue
                job_name, job_inline = job_match.groups()
                if job_inline.strip():
                    cursor += 1
                    continue
                job = Job(name=job_name, line=lines[cursor].line)
                jobs[job_name] = job
                inner = cursor + 1
                while inner < len(lines) and lines[inner].indent > 2:
                    perm_match = (
                        re.match(r"^permissions:\s*(.*)$", lines[inner].body)
                        if lines[inner].indent == 4
                        else None
                    )
                    if perm_match and job.permissions is None:
                        job.permissions, inner = parse_permissions(
                            lines, inner, perm_match.group(1), lines[inner].indent
                        )
                        continue
                    inner += 1
                cursor = inner
            index = cursor
            continue
        index += 1

    return Workflow(
        path=path,
        is_workflow=is_workflow,
        top_permissions=top,
        jobs=jobs,
        uses=uses,
    )


def audit_permissions(
    workflow: Workflow, permissions: Permissions | None, context: str, findings: list[Finding]
) -> None:
    if permissions is None:
        if context == "workflow":
            findings.append(
                Finding(
                    workflow.path,
                    1,
                    "PERMISSIONS_MISSING",
                    "workflow has no top-level permissions block; it inherits the "
                    "repository default and may be write-capable",
                )
            )
        return
    if permissions.value == "write-all":
        findings.append(
            Finding(
                workflow.path,
                permissions.line,
                "WRITE_ALL_FORBIDDEN",
                f"{context} uses 'permissions: write-all'",
            )
        )
    elif permissions.value and permissions.value not in ("read-all",):
        findings.append(
            Finding(
                workflow.path,
                permissions.line,
                "PERMISSIONS_INVALID",
                f"{context} has unrecognised permissions form {permissions.value!r}; "
                "use an explicit mapping, 'read-all', or '{}'",
            )
        )
    for scope, value in permissions.scopes.items():
        if scope not in KNOWN_SCOPES:
            findings.append(
                Finding(
                    workflow.path,
                    permissions.line,
                    "PERMISSIONS_INVALID",
                    f"{context} declares unknown permission scope {scope!r}",
                )
            )
        if value not in READ_VALUES | {"write"}:
            findings.append(
                Finding(
                    workflow.path,
                    permissions.line,
                    "PERMISSIONS_INVALID",
                    f"{context} permission {scope!r} has invalid value {value!r}",
                )
            )
        elif value == "write" and context == "workflow":
            findings.append(
                Finding(
                    workflow.path,
                    permissions.line,
                    "TOP_LEVEL_WRITE_FORBIDDEN",
                    f"top-level permission {scope!r} is 'write'; move it to the "
                    "job that needs it and add it to .github/workflow-policy.json",
                )
            )


def audit_pins(
    workflow: Workflow, findings: list[Finding]
) -> dict[str, dict[str, set[int]]]:
    """Check action references and return action -> SHA -> line numbers."""
    resolved: dict[str, dict[str, set[int]]] = {}
    for line, reference, comment in workflow.uses:
        if reference.startswith("./"):
            continue  # local reusable workflow / composite action
        if reference.startswith("docker://"):
            if not DOCKER_RE.match(reference):
                findings.append(
                    Finding(
                        workflow.path,
                        line,
                        "ACTION_UNPINNED",
                        f"docker action {reference!r} must be pinned with @sha256:<digest>",
                    )
                )
            continue
        match = ACTION_RE.match(reference)
        if not match or not SHA_RE.match(match.group("ref")):
            findings.append(
                Finding(
                    workflow.path,
                    line,
                    "ACTION_UNPINNED",
                    f"action {reference!r} is not pinned to a 40-character commit SHA"
                    + (f" ({comment})" if comment else ""),
                )
            )
            continue
        resolved.setdefault(match.group("repo"), {}).setdefault(match.group("ref"), set()).add(
            line
        )
    return resolved


def load_policy(
    path: Path, workflows: dict[str, Workflow], findings: list[Finding]
) -> dict[str, set[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        findings.append(Finding(".github/workflow-policy.json", 1, "POLICY_INVALID", "policy file is missing"))
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        findings.append(
            Finding(".github/workflow-policy.json", 1, "POLICY_INVALID", f"cannot read policy: {exc}")
        )
        return {}

    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        findings.append(
            Finding(
                ".github/workflow-policy.json",
                1,
                "POLICY_INVALID",
                "expected schemaVersion 1",
            )
        )
        return {}
    raw_entries = payload.get("allowedWriteScopes")
    if not isinstance(raw_entries, dict):
        findings.append(
            Finding(
                ".github/workflow-policy.json",
                1,
                "POLICY_INVALID",
                "allowedWriteScopes must be an object",
            )
        )
        return {}

    policy: dict[str, set[str]] = {}
    for key, scopes in raw_entries.items():
        workflow_name, separator, job_name = key.partition("::")
        workflow = workflows.get(workflow_name)
        if (
            not separator
            or workflow is None
            or not workflow.is_workflow
            or job_name not in workflow.jobs
        ):
            findings.append(
                Finding(
                    ".github/workflow-policy.json",
                    1,
                    "POLICY_STALE_ENTRY",
                    f"policy entry {key!r} does not match an existing workflow job",
                )
            )
            continue
        if not isinstance(scopes, list) or any(
            not isinstance(scope, str) or scope not in KNOWN_SCOPES for scope in scopes
        ):
            findings.append(
                Finding(
                    ".github/workflow-policy.json",
                    1,
                    "POLICY_INVALID",
                    f"policy entry {key!r} must list valid permission scopes",
                )
            )
            continue
        policy[key] = set(scopes)
    return policy


def audit_repository(root: Path, policy_path: Path | None = None) -> list[Finding]:
    """Audit a repository checkout and return all findings."""
    root = root.resolve()
    policy_path = policy_path or root / ".github" / "workflow-policy.json"
    workflow_dir = root / ".github" / "workflows"
    files = sorted(workflow_dir.glob("*.yml")) + sorted(workflow_dir.glob("*.yaml"))
    action_dir = root / ".github" / "actions"
    if action_dir.is_dir():
        files += sorted(action_dir.glob("**/action.yml")) + sorted(
            action_dir.glob("**/action.yaml")
        )

    findings: list[Finding] = []
    workflows: dict[str, Workflow] = {}
    for file_path in files:
        relative = file_path.relative_to(root).as_posix()
        is_workflow = relative.startswith(".github/workflows/")
        try:
            text = file_path.read_text(encoding="utf-8")
        except OSError as exc:
            findings.append(Finding(relative, 1, "IO_ERROR", f"cannot read workflow: {exc}"))
            continue
        workflow = parse_workflow(relative, text, is_workflow)
        workflows[relative] = workflow
        if is_workflow:
            audit_permissions(workflow, workflow.top_permissions, "workflow", findings)

    policy = load_policy(policy_path, workflows, findings)
    declared_writes: dict[str, set[str]] = {}
    pin_lines: dict[str, dict[str, dict[str, set[int]]]] = {}
    for relative, workflow in workflows.items():
        for name, job in workflow.jobs.items():
            if job.permissions is None:
                continue
            audit_permissions(workflow, job.permissions, f"job {name!r}", findings)
            writes = {
                scope for scope, value in job.permissions.scopes.items() if value == "write"
            }
            if writes:
                declared_writes[f"{relative}::{name}"] = writes
        if workflow.is_workflow:
            pin_lines[relative] = audit_pins(workflow, findings)

    for key, scopes in declared_writes.items():
        allowed = policy.get(key, set())
        for scope in sorted(scopes - allowed):
            workflow_name, _, job_name = key.partition("::")
            findings.append(
                Finding(
                    workflow_name,
                    workflows[workflow_name].jobs[job_name].line,
                    "WRITE_SCOPE_NOT_ALLOWLISTED",
                    f"job {job_name!r} grants unapproved write scope {scope!r}",
                )
            )
    for key, scopes in policy.items():
        for scope in sorted(scopes - declared_writes.get(key, set())):
            findings.append(
                Finding(
                    ".github/workflow-policy.json",
                    1,
                    "POLICY_STALE_ENTRY",
                    f"policy entry {key!r} lists unused write scope {scope!r}",
                )
            )

    action_pins: dict[str, dict[str, list[tuple[str, int]]]] = {}
    for relative, per_action in pin_lines.items():
        for action, shas in per_action.items():
            for sha, lines in shas.items():
                action_pins.setdefault(action, {}).setdefault(sha, []).extend(
                    (relative, line) for line in lines
                )
    for action, shas in sorted(action_pins.items()):
        if len(shas) < 2:
            continue
        first_sha, first_locations = sorted(shas.items())[0]
        reference = f"{first_locations[0][0]}:{first_locations[0][1]}"
        for sha, locations in sorted(shas.items()):
            if sha == first_sha:
                continue
            for relative, line in locations:
                findings.append(
                    Finding(
                        relative,
                        line,
                        "ACTION_PIN_DRIFT",
                        f"action {action!r} is pinned to {sha[:12]} but to "
                        f"{first_sha[:12]} in {reference}",
                    )
                )
    return findings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--policy", type=Path, default=None)
    parser.add_argument("--json", action="store_true", help="emit findings as JSON")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    findings = audit_repository(args.root, args.policy)
    if args.json:
        print(json.dumps([finding.as_dict() for finding in findings], indent=2))
    else:
        for finding in findings:
            print(finding.render())
        if findings:
            print(f"\n{len(findings)} workflow policy finding(s).", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
