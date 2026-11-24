# Threat Model: Provider Callbacks and Admin Reconciliation Trust Boundaries

## 1. Purpose and Scope

This document describes the trust boundaries, data flows, attacker-controlled inputs, trust assumptions, and abuse cases for the following operations in the DEX-with-Fiat backend:

- **Provider webhooks** — inbound callbacks from the fiat on/off-ramp provider (payment status, settlement, refund events).
- **Admin retry / reconciliation** — operator-initiated retries of provider callbacks and manual reconciliation of provider events against the internal audit ledger.

The goal is to map each high-risk scenario to a **preventive control** and the **regression test** that covers it, so that changes to these code paths can be reviewed against a stable threat baseline.

Out of scope: provider-side security, general authentication of end users, and the internal ledger's double-entry invariants (covered by the ledger threat model).

## 2. Assets and Trust Boundaries

| Asset | Description | Sensitivity |
| --- | --- | --- |
| `HMAC_SECRET` | Shared secret used to verify provider webhook signatures | Critical — compromise allows forged callbacks |
| Audit ledger | Append-only record of provider events and reconciliation actions | High — financial source of truth |
| Dedupe store | Persisted set of processed event IDs | High — prevents double-crediting |
| Admin session | Authenticated operator identity for retry/reconciliation | High — grants privileged actions |
| Provider event payload | Amount, status, reference, event ID | Medium — attacker-controlled |

Trust boundaries:

1. **Provider → Backend (webhook endpoint).** Everything in the HTTP request (body, headers, query) is attacker-controlled until the signature is verified.
2. **Backend → Dedupe store.** The dedupe store is trusted only if durable and transactional with ledger writes.
3. **Admin client → Backend (admin API).** The admin session is trusted only after authentication and authorization checks; the request body is still attacker-controlled (an operator can be tricked or a session hijacked).
4. **Backend → Audit ledger.** The ledger is the trusted record; all mutations must be attributable.

## 3. Data Flows

### 3.1 Provider webhook flow

```
Provider
  │  POST /webhooks/provider  (body, X-Signature, X-Timestamp, event id)
  ▼
[1] Signature verification  ── HMAC over canonical payload + timestamp
  ▼
[2] Replay / clock-skew check ── timestamp within tolerance window
  ▼
[3] Dedupe check ── event id not already processed (durable store)
  ▼
[4] Reconciliation ── match event to internal payment intent, validate amount/status
  ▼
[5] Audit ledger append ── record event, decision, and actor=provider
  ▼
[6] Acknowledge provider (2xx only after durable commit)
```

### 3.2 Admin retry / reconciliation flow

```
Admin client
  │  POST /admin/provider-events/{id}/retry  or  /admin/reconcile
  ▼
[1] Admin session authentication + authorization (role check)
  ▼
[2] Load original event from audit ledger (read-only)
  ▼
[3] Re-run reconciliation for the referenced event
  ▼
[4] Audit ledger append ── record action, actor=admin:<id>, reason
  ▼
[5] Return result to admin
```

## 4. Attacker-Controlled Fields

| Field | Source | Notes |
| --- | --- | --- |
| Payload body | Webhook request | Entire JSON body is untrusted until signature verified |
| Signature header (`X-Signature`) | Webhook request | Attacker can send arbitrary value |
| Timestamp header (`X-Timestamp`) | Webhook request | Used for replay window; attacker-controlled |
| Event ID / reference | Payload body | Used for dedupe; attacker can replay or forge |
| Amount | Payload body | Must be validated against internal intent |
| Status | Payload body | Must be validated against allowed transitions |
| Actor (admin) | Admin request | Identity from session, not from body; body-supplied actor must be ignored |

## 5. Trust Assumptions

| Assumption | Rationale | Failure impact |
| --- | --- | --- |
| `HMAC_SECRET` is stored in a secret manager and never logged | Prevents forgery | Forged callbacks accepted |
| Clock skew tolerance is bounded (e.g. ±5 min) | Limits replay window | Stale callbacks accepted |
| Dedupe store is durable and written in the same transaction as the ledger append | Prevents double-processing | Duplicate credit |
| Admin session integrity is enforced by the auth layer | Prevents privilege escalation | Unauthorized retry/reconciliation |
| Provider event IDs are globally unique per provider | Enables dedupe | Collisions cause missed or duplicate events |

## 6. Abuse Cases and Controls

Each high-risk scenario is mapped to a preventive control and the regression test that covers it.

### 6.1 Replay of a valid webhook

- **Scenario:** Attacker captures a valid signed webhook and replays it later.
- **Control:** Timestamp header checked against a bounded clock-skew window; event ID dedupe rejects already-processed events.
- **Regression test:** `test_webhook_replay_rejected` — replays a captured payload with an old timestamp and asserts `409`/`400` and no ledger append.

### 6.2 Forged signature

- **Scenario:** Attacker sends a webhook with an invalid or missing `X-Signature`.
- **Control:** HMAC verification over canonical payload + timestamp; constant-time comparison; reject on mismatch before any state change.
- **Regression test:** `test_webhook_forged_signature_rejected` — sends tampered body with original signature and asserts `401` and no ledger append.

### 6.3 Stale signature (expired timestamp)

- **Scenario:** Attacker replays a valid signature outside the tolerance window.
- **Control:** Timestamp must be within `CLOCK_SKEW_TOLERANCE`; reject otherwise.
- **Regression test:** `test_webhook_stale_timestamp_rejected` — sends a correctly signed payload with a timestamp outside the window and asserts rejection.

### 6.4 Out-of-order status transitions

- **Scenario:** Attacker sends a `refunded` event before `settled`, or a `settled` after `refunded`.
- **Control:** Reconciliation enforces an allowed state-transition table per payment intent; invalid transitions are rejected and audited.
- **Regression test:** `test_reconciliation_rejects_invalid_transition` — sends out-of-order statuses and asserts the ledger records a rejection without mutating the intent.

### 6.5 Duplicate event

- **Scenario:** Provider retries delivery of the same event ID.
- **Control:** Dedupe store keyed by event ID; duplicate returns `200` idempotently without re-applying.
- **Regression test:** `test_webhook_duplicate_event_idempotent` — sends the same event twice and asserts a single ledger entry.

### 6.6 Unauthorized admin retry

- **Scenario:** A non-admin or unauthenticated caller invokes the retry endpoint.
- **Control:** Admin session authentication + role authorization; actor derived from session, never from request body.
- **Regression test:** `test_admin_retry_requires_admin_role` — calls retry without admin role and asserts `403` and no ledger append.

### 6.7 Cross-owner reconciliation read

- **Scenario:** An admin (or compromised session) attempts to read or reconcile an event belonging to another owner/tenant.
- **Control:** Reconciliation queries are scoped by owner/tenant from the session; cross-owner access returns `404` (not `403`) to avoid enumeration.
- **Regression test:** `test_reconciliation_cross_owner_denied` — requests an event owned by another tenant and asserts `404` and no data leakage.

### 6.8 Amount tampering

- **Scenario:** Attacker sends a validly signed event with a manipulated amount.
- **Control:** Amount is validated against the internal payment intent; mismatch is rejected and audited.
- **Regression test:** `test_reconciliation_amount_mismatch_rejected` — sends a mismatched amount and asserts rejection with an audit entry.

## 7. Control-to-Test Matrix

| # | Abuse case | Preventive control | Regression test |
| --- | --- | --- | --- |
| 6.1 | Replay | Timestamp window + dedupe | `test_webhook_replay_rejected` |
| 6.2 | Forged signature | HMAC verify, constant-time | `test_webhook_forged_signature_rejected` |
| 6.3 | Stale signature | Clock-skew tolerance | `test_webhook_stale_timestamp_rejected` |
| 6.4 | Out-of-order transition | State-transition table | `test_reconciliation_rejects_invalid_transition` |
| 6.5 | Duplicate event | Durable dedupe store | `test_webhook_duplicate_event_idempotent` |
| 6.6 | Unauthorized admin retry | AuthN + role AuthZ | `test_admin_retry_requires_admin_role` |
| 6.7 | Cross-owner read | Owner-scoped queries, 404 | `test_reconciliation_cross_owner_denied` |
| 6.8 | Amount tampering | Intent amount validation | `test_reconciliation_amount_mismatch_rejected` |

## 8. Wallet Permission Trust Boundary (Least-Privilege Signing)

This section covers the client-side wallet boundary that fronts the fiat flows above. It is included here because a wallet session that over-requests permissions or half-authenticates can bypass the intent validation described in §6.

### 8.1 Principle

Each user action requests **only** the wallet capability it needs, at the moment it needs it:

| Action | Wallet capability requested | Never requested here |
| --- | --- | --- |
| View balances / history | Read-only account access (`eth_requestAccounts` / `wallet_getPermissions`) | Signing, transaction approval |
| Connect wallet (session start) | Account access only | Message signing, tx signing |
| Sign-in / auth challenge | Message signing (`personal_sign` / `eth_signTypedData_v4`) | Transaction signing |
| Submit on-ramp / off-ramp order | Transaction signing for the specific tx | Blanket account re-approval |

A blanket "connect + sign" flow is explicitly disallowed: connecting must not imply signing, and signing must not silently re-request accounts.

### 8.2 Prompt explanation

Before each request the UI states what is being asked and why (e.g. "Your wallet will ask you to sign a message to prove ownership — this does not move funds"). The prompt copy is shown at the point of request, not only at connect time.

### 8.3 Denial handling

- A denied permission or signature request leaves **no partially authenticated session**: the app does not mark the user as connected/signed-in, does not persist a session token, and clears any pending intent.
- The UI returns to a recoverable state (retry button, unchanged balances) and surfaces a non-blocking message explaining the denial.
- Denial is treated as a normal outcome, not an error that mutates financial state; no order is created and no ledger entry is written.

### 8.4 Abuse cases and controls

| # | Abuse case | Preventive control | Regression test |
| --- | --- | --- | --- |
| 8.4.1 | Over-broad permission request on connect | Connect requests account access only; signing requested per-action | `test_connect_requests_accounts_only` |
| 8.4.2 | Signing requested without user intent | Signing only triggered by explicit action; prompt explains scope | `test_sign_prompt_explains_scope` |
| 8.4.3 | Denied signature leaves half-auth session | Denial clears pending intent and session state | `test_denied_signature_no_partial_session` |
| 8.4.4 | Denied account access leaves stale connected state | Denial resets connected state to disconnected | `test_denied_accounts_resets_connection` |

### 8.5 Compatibility note

This is an intentional behavior change: previously a single connect flow also requested signing. Now signing is requested per action. Integrators relying on the old combined prompt must request signing explicitly at the action site. No financial safety property changes — intent validation (§6.8) and state transitions (§6.4) are unchanged.
