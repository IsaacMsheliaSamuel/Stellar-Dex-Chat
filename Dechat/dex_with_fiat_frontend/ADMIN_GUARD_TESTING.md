# AdminGuard test coverage

The AdminGuard authorization boundary is covered by
`src/components/__tests__/AdminGuard.test.tsx`.

The suite verifies the protected-content behavior for an allowed administrator,
an unauthenticated visitor, a malformed address, and a non-admin address. Run
the focused suite with:

```bash
npm run test -- src/components/__tests__/AdminGuard.test.tsx
```

This document records the coverage requested in issue #595 and gives
maintainers a direct CI-equivalent command for reviewing it.

---

# Emergency pause & recovery operator drill

This drill is a repeatable testnet/local-network rehearsal for the emergency
pause and recovery path (issue #191). It pauses the contract, confirms that
mutations are blocked while read-only views remain available, verifies that
queued liabilities are preserved, and rehearses authorized recovery. Run it
against a local network or testnet — never against mainnet.

## Preconditions

- A deployed contract instance on a local network or testnet.
- The operator holds the admin key authorized to pause/unpause.
- At least one queued liability exists (e.g. a pending payout) so the drill can
  confirm it survives the pause.

## Drill steps

1. **Snapshot state.** Record the current queued liabilities and any balances
   you intend to compare after recovery.
2. **Pause (authorized).** Submit the pause as the admin. Expect success and a
   paused state on the contract.
3. **Confirm blocked mutations.** Attempt a state-changing call (e.g. enqueue a
   payout or release funds). Expect the call to be rejected while paused and
   confirm no state change occurred.
4. **Confirm views remain available.** Call read-only views (balances, queued
   liabilities, paused flag). Expect them to succeed and return the pre-pause
   data.
5. **Verify queued liabilities.** Confirm the queued liabilities recorded in
   step 1 are unchanged and still present while paused.
6. **Unauthorized attempts (failure cases).** Attempt pause and unpause as a
   non-admin. Expect both to be rejected with no state change.
7. **Recover (authorized unpause).** Submit the unpause as the admin. Expect
   success and a resumed state.
8. **Confirm recovery.** Re-run the queued-liability view and confirm the
   liabilities are intact and can now be processed; confirm mutations succeed
   again.

## Expected outcomes

| Step | Actor      | Expected result                          |
| ---- | ---------- | ---------------------------------------- |
| 2    | admin      | pause succeeds, contract paused          |
| 3    | any        | mutation rejected, no state change       |
| 4    | any        | read-only views succeed                  |
| 5    | any        | queued liabilities unchanged             |
| 6    | non-admin  | pause/unpause rejected, no state change  |
| 7    | admin      | unpause succeeds, contract resumed       |
| 8    | any        | liabilities intact, mutations succeed    |

## Regression coverage

The focused regression tests cover the normal pause/recovery path plus the
failure and authorization edge cases above (blocked mutations while paused,
read-only views during pause, preserved queued liabilities, and rejected
unauthorized pause/unpause). Run them with the contract test command used in
CI (see `.github/workflows/contracts.yml`).

---

# Threat Model & Abuse-Case Register

- **Document version:** `TM-1.0.0`
- **Status:** Published
- **Owner:** Security (reviewed with contract, frontend, and API owners)
- **Scope:** browser, wallet, API, model provider, Soroban, payout provider
- **Excludes:** operational secrets (keys, tokens, credentials, endpoints with
  embedded auth). No secret material is recorded in this document.

## Change history

| Version | Date       | Author   | Summary of change                                   |
| ------- | ---------- | -------- | --------------------------------------------------- |
| 1.0.0   | 2024-01-01 | Security | Initial published threat model and abuse-case register |

Review triggers (a new revision is required when any of these occur):

- A new trust boundary is introduced (new service, new external provider).
- A new payout provider or payout rail is added.
- A Soroban contract upgrade or new contract is deployed.
- A change to signing, admin authorization, tool routing, or webhook handling.
- A new model provider or change to model-provider data handling.

## Trust boundaries

| Boundary | Component | Trust level | Notes |
| -------- | --------- | ----------- | ----- |
| B1 | Browser (frontend) | Untrusted | User-controlled; all input validated server-side |
| B2 | Wallet | Untrusted | Signs user intent; never trusted for authorization |
| B3 | API | Trusted | Enforces auth, quotas, and admin guards |
| B4 | Model provider | Semi-trusted | External; receives only routed prompt data |
| B5 | Soroban | Trusted (on-chain) | Contract state is authoritative for settlement |
| B6 | Payout provider | Semi-trusted | External; receives payout instructions only |

## Sensitive data & authority flows

### Signing

- **Data:** user key material stays in the wallet (B2); the browser (B1) only
  receives signed payloads.
- **Authority:** signing authority is held by the wallet; the API (B3) verifies
  signatures and never holds private keys.
- **Control:** signature verification on the API before any state change.

### Admin actions

- **Data:** admin identity/address.
- **Authority:** admin authority is enforced by `AdminGuard`
  (`src/components/__tests__/AdminGuard.test.tsx`).
- **Control:** allow-list check; unauthenticated, malformed, and non-admin
  addresses are denied.

### Tool routing

- **Data:** user prompts and tool arguments.
- **Authority:** the API (B3) decides which tools are invoked; the model
  provider (B4) only proposes.
- **Control:** server-side tool allow-list and per-user quota enforcement
  (`src/lib/ai/quota.ts`).

### Webhooks

- **Data:** provider callbacks and event payloads.
- **Authority:** webhook handlers act on behalf of external providers.
- **Control:** signature/authenticity verification before processing; reject
  unverified payloads.

### Payout

- **Data:** payout instructions and amounts.
- **Authority:** payout is initiated by the API (B3) and settled via Soroban
  (B5) / payout provider (B6).
- **Control:** admin authorization plus on-chain settlement as source of truth.
  High-risk manual payout actions (retry, release, override) additionally
  require **dual control**: an independent reviewer must approve the action
  before it executes (see "Dual control for high-risk payout actions").

## Abuse-case register

| ID  | Abuse case | Impact | Likelihood | Controls | Owner | Residual risk |
| --- | ---------- | ------ | ---------- | -------- | ----- | ------------- |
| AC1 | Unauthorized admin action | High | Low | `AdminGuard` allow-list; tests in `AdminGuard.test.tsx` | Frontend | Low |
| AC2 | Quota bypass / resource abuse | Medium | Medium | Per-user quota in `src/lib/ai/quota.ts`; usage metrics in `src/lib/ai/usage-metrics.ts` | API | Low |
| AC3 | Forged webhook triggers payout | High | Low | Webhook authenticity verification; admin authorization | API | Low |
| AC4 | Prompt/tool data leakage to model provider | Medium | Medium | Server-side tool routing; minimal prompt data | API | Medium |
| AC5 | Signature replay on signing flow | High | Low | Signature verification on API before state change | Contract | Low |
| AC6 | Payout provider compromise | High | Low | On-chain settlement (Soroban) as source of truth | Contract | Medium |
| AC7 | Single-actor abuse of high-risk manual payout action (retry/release/override) | High | Low | Dual control: independent reviewer approval; self-approval blocked; requester/approver/reason/before-after persisted | API | Low |

## Mitigation links

- AC1 → `src/components/__tests__/AdminGuard.test.tsx`
- AC2 → `src/lib/ai/quota.ts`, `src/lib/ai/usage-metrics.ts`
- AC3 → webhook verification (tracked follow-up: add webhook signature tests)
- AC4 → server-side tool routing (tracked follow-up: document provider data handling)
- AC5 → API signature verification (tracked follow-up: add replay-protection test)
- AC6 → Soroban settlement (tracked follow-up: contract upgrade review checklist)
- AC7 → dual-control approval flow (see "Dual control for high-risk payout actions")

## Validation

Reviewed with contract, frontend, and API owners. Every high-risk flow (AC1,
AC3, AC5, AC6, AC7) has an explicit control or a tracked follow-up gap recorded
above.

---

# Dual control for high-risk payout actions

High-risk manual payout actions — **retry**, **release**, and **override** —
require independent reviewer approval before they execute (issue #229). This
section documents the contract, API, and UI conventions for that flow.

## Which actions require dual control

Dual control is required for the configured high-risk actions:

| Action    | Description                                              |
| --------- | -------------------------------------------------------- |
| `retry`   | Re-attempt a failed or stuck payout                       |
| `release` | Release held funds to the recipient                       |
| `override`| Override a payout state or amount decision                |

Low-risk actions (e.g. read-only inspection) do not require approval.

## Approval record

Every dual-control action persists an approval record with:

- **requester** — the admin who initiated the action.
- **approver** — the independent admin who approved it.
- **reason** — the written justification supplied by the requester.
- **before state** — the payout state prior to the action.
- **after state** — the intended payout state once approved and executed.
- **timestamps** — requested-at and approved-at.

The record is written atomically with the state transition so the audit trail
cannot diverge from the applied change.

## Self-approval prevention

The requester **cannot** approve their own action. The API rejects an approval
where `approver == requester` with `403` and applies no state change. The UI
hides the approve control for the requester, but hiding the control is **not**
the security boundary — the server enforces the check on every request.

## Flow

1. Requester submits the action with a reason; the action enters `pending`
   with the before state captured.
2. An independent reviewer (not the requester) approves or rejects.
3. On approval, the action executes and the after state is recorded.
4. On rejection, the payout state is unchanged and the rejection is audited.

## Failure & boundary cases

- **Self-approval** → `403`, no state change.
- **Unauthorized approver** (not an admin) → `403`, no state change.
- **Missing reason** → `400`, no state change.
- **Already-approved action** → rejected, no duplicate execution.
