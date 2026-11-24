# Workflow permission and action pinning policy

This runbook covers the repository's GitHub Actions supply-chain guard
(issue #289). It is enforced by `tools/workflow_guard.py` in the
`Lint Repo / lint` check on every pull request.

## Policy

| Rule | Rationale |
| --- | --- |
| Every workflow declares top-level `permissions` | A missing block inherits the repository default, which may be write-capable. |
| Top-level scopes are read-only (`read` / `none` / `read-all` / `{}`) | Write access must be narrowed to the job that needs it. |
| `permissions: write-all` is forbidden everywhere | It grants unrelated scopes such as `contents`, `packages`, and `id-token`. |
| Job-level `write` scopes are allowlisted per `workflow::job` | The allowlist makes every privilege escalation reviewable in one file. |
| Third-party `uses:` refs are 40-character commit SHAs | Tags and branches are mutable and can be repointed after review. |
| One action resolves to one SHA across the repository | Silent drift between workflows is itself a supply-chain signal. |
| `docker://` refs carry `@sha256:<64-hex digest>` | Image tags are mutable. |
| Local reusable workflows are exempt | They are read from the same immutable checkout. |

The authoritative allowlist is `.github/workflow-policy.json`. An entry is valid
only when the workflow and job exist and the listed scope is actually declared
with `write` by that job. Stale entries and unused scopes fail the audit, so the
policy cannot accumulate forgotten privileges.

### Current write-scope inventory

| Workflow job | Write scopes | Why |
| --- | --- | --- |
| `auto-merge.yml::auto-merge` | `contents`, `pull-requests` | Squash-merge opted-in PRs. |
| `changelog.yml::update-changelog` | `contents` | Commit generated `CHANGELOG.md`. |
| `coverage-comment.yml::comment` | `pull-requests` | Post/update the coverage comment. |
| `deploy-futurenet.yml::deploy` | `deployments` | Create the GitHub Deployment record. |
| `lint-repo.yml::lint` | `checks` | reviewdog `github-pr-check` reporter. |
| `preview-deploy.yml::deploy-preview` | `pull-requests`, `deployments` | Preview URL comment, label, deployment status. |
| `preview-teardown.yml::teardown-on-close` | `pull-requests`, `deployments` | Remove label/comment and deactivate deployment. |
| `preview-teardown.yml::expiry-sweep` | `pull-requests`, `deployments` | Scheduled expiry of stale previews. |
| `security-audit.yml::release-sbom` | `contents` | Attach SBOM/provenance to a release. |
| `security-audit.yml::open-tracking-issue` | `issues` | Open/comment on the audit failure issue. |
| `signed-attestations.yml::attest-contract` | `attestations`, `id-token` | Sigstore signing and bundle storage. |
| `signed-attestations.yml::attest-frontend` | `attestations`, `id-token` | Sigstore signing and bundle storage. |
| `signed-attestations.yml::release-upload` | `contents` | Attach attestation bundles to a release. |
| `wasm-size-comment.yml::comment` | `pull-requests` | Post/update the WASM size comment. |

Every other job inherits a read-only default. No financial capability flags,
deployment targets, secret names, or contract state transitions were changed by
this policy: the existing write scopes were moved from workflow level to job
level without broadening them.

## Run locally

```sh
# audit the checkout
python3 tools/workflow_guard.py

# machine-readable output for automation
python3 tools/workflow_guard.py --json

# focused regression tests (normal path, failures, policy edge cases)
python3 -m unittest discover -s tools/tests -p 'test_workflow_guard.py' -v
```

Exit codes: `0` clean, `1` policy findings, `2` CLI/IO error. The tool uses only
the Python standard library and does not contact the network.

## Adding or updating a pin

1. Resolve the immutable commit for the intended release, for example:
   ```sh
   gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.sha'
   ```
   For annotated tags dereference the tag object with
   `gh api repos/<owner>/<repo>/git/tags/<tag-object-sha> --jq '.object.sha'`.
   For `dtolnay/rust-toolchain`, pin the current `stable` branch head.
2. Replace the ref in **every** workflow that uses the action and keep the
   `# vX.Y.Z` comment accurate. Do not change one workflow alone: the drift
   check will fail.
3. Run the audit and its tests locally, then confirm `Lint Repo / lint` passes
   on the pull request.

## Adding a write scope

1. Narrow the scope to a single job (never the workflow-wide block).
2. Add the exact `".github/workflows/<file>.yml::<job>": ["<scope>"]` entry to
   `.github/workflow-policy.json`.
3. Describe the need in the pull request description. Reviewers should confirm
   the step actually requires the scope and that no broader scope was added.

## Recovery when the check fails

| Finding | Recovery |
| --- | --- |
| `ACTION_UNPINNED` | Replace the mutable ref with the release commit SHA (see above). |
| `ACTION_PIN_DRIFT` | Align all workflows on one SHA, or intentionally bump them together in one PR. |
| `PERMISSIONS_MISSING` | Add `permissions: contents: read` at workflow top level. |
| `TOP_LEVEL_WRITE_FORBIDDEN` | Move the scope to the job that uses it and add the allowlist entry. |
| `WRITE_ALL_FORBIDDEN` | Enumerate the exact scopes and add only those to the relevant jobs. |
| `WRITE_SCOPE_NOT_ALLOWLISTED` | Remove the scope if unnecessary, or document and allowlist it. |
| `POLICY_STALE_ENTRY` / `POLICY_INVALID` | Update `.github/workflow-policy.json` to match the workflows exactly. |

If a write-capable workflow was merged with an unintended scope, treat the
token as exposed: revert the offending commit, rotate any secret used by that
workflow (see [provider credential rotation](../PROVIDER_CREDENTIAL_ROTATION.md)
and [signer recovery](../SIGNER_RECOVERY_AND_KEY_ROTATION.md)), and review the
workflow run history for unauthorised deployments or releases. Deployment and
release gates (`staged-deploy.yml`, `signed-attestations.yml`) remain unchanged;
their verification steps are read-only and still block promotion on mismatch.

## Related documentation

- [Secret scanning](secret-scanning.md) — committed-tree, PR-commit, and release
  artifact scanning.
- [Branch protection](../branch-protection.md) — required status checks,
  including `Lint Repo / lint` which runs this guard.
- [Release attestations](release-attestations.md) — artifact identity and
  verification.
