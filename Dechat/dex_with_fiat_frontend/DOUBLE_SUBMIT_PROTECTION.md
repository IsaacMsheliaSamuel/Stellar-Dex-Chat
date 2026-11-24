# Double-Submit Protection Implementation

This document describes the implementation of guardrails to prevent accidental double-submit actions in the application.

## Overview

The implementation adds idempotent button disabled/loading states for critical actions, prevents duplicate form submit events, logs suppressed duplicates for diagnostics, and includes comprehensive tests for rapid-click scenarios.

## Core Implementation

### useIdempotentAction Hook

Location: `src/hooks/useIdempotentAction.ts`

A reusable React hook that provides idempotency guarantees for critical actions:

**Features:**

- Prevents duplicate submissions during configurable cooldown period (default: 2000ms)
- Tracks processing state for UI feedback
- Generates unique idempotency keys per action
- Logs suppressed duplicate attempts for diagnostics
- Handles errors gracefully

**Usage:**

```typescript
const { execute, isProcessing } = useIdempotentAction({
  cooldownMs: 2000,
  logSuppressed: true,
});

const handleSubmit = async () => {
  await execute(async (idempotencyKey) => {
    // Your action here
    await fetch('/api/endpoint', {
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
    });
  }, 'action_name');
};
```

## Protected Components

### 1. ChatInput Component

Location: `src/components/ChatInput.tsx`

**Protection Added:**

- Prevents duplicate message submissions on rapid Enter key presses
- Prevents duplicate submissions on rapid button clicks
- Cooldown period: 1000ms
- Disables submit button while processing

**Changes:**

- Added `useIdempotentAction` hook
- Wrapped `onSendMessage` call in `executeSubmit`
- Added `isSubmitting` state to button disabled condition
- Updated loading spinner to show during submission

### 2. BankDetailsModal Component

Location: `src/components/BankDetailsModal.tsx`

**Protection Added:**

- Prevents duplicate payout confirmations
- Cooldown period: 3000ms (longer due to critical financial operation)
- Includes idempotency keys in API requests
- Disables confirm button while processing

**Changes:**

- Added `useIdempotentAction` hook
- Wrapped payout confirmation logic in `executePayoutConfirm`
- Added `X-Idempotency-Key` header to `/api/create-recipient` and `/api/initiate-transfer` requests
- Added `isPayoutProcessing` to button disabled condition

### 3. StellarFiatModal Component

Location: `src/components/StellarFiatModal.tsx`

**Protection Added:**

- Prevents duplicate deposit/withdrawal transactions
- Cooldown period: 2000ms
- Generates unique idempotency keys for blockchain transactions
- Disables action button while processing

**Changes:**

- Added `useIdempotentAction` hook (replacing manual cooldown logic)
- Wrapped transaction logic in `executeTransaction`
- Removed manual `lastActionTimestamp` checks (now handled by hook)
- Added `isTxProcessing` to button disabled condition
- Idempotency key passed to transaction handlers

## Pre-Submit Wallet Revalidation

Location: `src/components/StellarFiatModal.tsx`

Double-submit protection alone is not enough for signed XDR submissions: the
wallet account, network, or configured contract identity can change between the
moment the user confirms and the moment the signed transaction is submitted.
Immediately before submission the flow re-reads the live values and compares
them against the snapshot captured at confirmation time.

**Revalidated values:**

- Active wallet address (public key)
- Network passphrase
- Configured contract identity (contract ID)

**Behavior:**

- The snapshot is captured when the user confirms the action.
- After confirmation and immediately before submitting the XDR, the current
  wallet address, network passphrase, and contract identity are re-read.
- If any of the three values differs from the snapshot, submission is aborted
  before any XDR is sent.
- The abort surfaces a recoverable, user-facing message explaining which value
  changed and asking the user to review and retry. No transaction is submitted
  and no funds move.
- Existing financial safety properties are preserved: the idempotent action
  guard still prevents double submission, and the abort path is logged for
  audit/diagnostics without recording secrets or real user data.

**Intentional behavior change:** a submission that would previously have
proceeded with a stale wallet/network/contract identity now aborts with a
recoverable error instead of being sent. This is the intended safety property.

**Regression tests** cover the normal path (values unchanged, submission
proceeds) and the failure/recovery edge cases (wallet address changed, network
passphrase changed, contract identity changed), asserting that submission is
aborted and a recoverable message is shown.

## Transaction Recovery State Machine

Location: `src/lib/transactions/txStateMachine.ts`

A signed XDR submission is not a single atomic step. It moves through a
sequence of observable states, and a crash, reload, or wallet disconnect can
interrupt it at any point. To make recovery deterministic, transaction progress
is modeled as an explicit, persisted, typed state machine rather than an
implicit set of booleans.

### States

| State       | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `built`     | Transaction envelope assembled, not yet signed.                         |
| `signed`    | Wallet returned a signed XDR; not yet submitted.                        |
| `submitted` | Signed XDR handed to the network; no confirmation observed yet.         |
| `pending`   | Submission acknowledged; awaiting ledger inclusion / confirmation.      |
| `confirmed` | Terminal success: transaction included and confirmed.                   |
| `failed`    | Terminal failure: proven rejection (e.g. pre-connection rejection).     |
| `expired`   | Terminal: timebounds elapsed before confirmation; must be rebuilt.      |

### Allowed transitions

```
built     -> signed | failed | expired
signed    -> submitted | failed | expired
submitted -> pending | confirmed | failed | expired
pending   -> confirmed | failed | expired
confirmed -> (terminal)
failed    -> (terminal)
expired   -> (terminal)
```

Any transition not listed above is impossible and is rejected by the machine
with a typed `InvalidTransitionError` carrying the `from` and `to` states. This
makes impossible transitions detectable in code and in tests instead of being
silently accepted.

### Persisted recovery data

Only the minimum data needed to resume or reconcile a transaction is persisted
(under a per-transaction key, e.g. `localStorage`):

- `id` — client-generated transaction id (also the idempotency key)
- `state` — current state from the table above
- `hash` — network transaction hash, once known (after `submitted`)
- `walletAddress` — public key that signed (for revalidation on resume)
- `networkPassphrase` — network the transaction targets
- `contractId` — configured contract identity at signing time
- `updatedAt` — ISO timestamp of the last transition

No secrets, signed XDR blobs, or real user data are persisted. On reload the
machine rehydrates from this record and resumes from the recorded state; a
`submitted`/`pending` record is reconciled against the network by `hash` rather
than resubmitted, preserving the double-submit protection above.

### Regression tests

Location: `src/lib/transactions/__tests__/txStateMachine.test.ts`

Tests cover:

- ✅ Normal path: `built -> signed -> submitted -> pending -> confirmed`
- ✅ Persistence round-trip: rehydrate resumes from the recorded state
- ✅ Impossible transitions rejected with `InvalidTransitionError`
- ✅ Terminal states reject all further transitions
- ✅ Failure path: `submitted -> failed` is terminal and not retried
- ✅ Expiry path: `pending -> expired` requires a rebuild, not a resubmit
- ✅ Recovery: a persisted `submitted` record reconciles by hash, never resubmits
- ✅ Authorization: a resumed record whose `walletAddress` no longer matches the
  active wallet is rejected before any submission

## Diagnostic Logging

All suppressed duplicate attempts are logged to the console with the following information:

```javascript
{
  actionName: 'action_name',
  isProcessing: boolean,
  timeSinceLastExecution: number,
  cooldownMs: number,
  timestamp: ISO string
}
```

This allows developers and support teams to:

- Identify UI/UX issues causing users to double-click
- Monitor for potential bugs or race conditions
- Track user behavior patterns
- Debug submission issues

## Testing

### Unit Tests

Location: `src/hooks/__tests__/useIdempotentAction.test.ts`

Tests cover:

- ✅ Successful action execution
- ✅ Duplicate submission prevention during cooldown
- ✅ Execution allowed after cooldown period
- ✅ Processing state tracking
- ✅ Suppressed duplicate logging
- ✅ Unique idempotency key generation
- ✅ State reset functionality
- ✅ Error handling
- ✅ Rapid-click scenarios
- ✅ Blocking submissions while processing

### Integration Tests

**ChatInput Tests**
Location: `src/components/__tests__/ChatInput.rapid-click.test.tsx`

Tests cover:

- ✅ Preventing duplicate submissions on rapid Enter presses
- ✅ Preventing duplicate submissions on rapid button clicks
- ✅ Button disabled state while processing
- ✅ Submission allowed after cooldown
- ✅ No submission when loading
- ✅ Logging suppressed attempts
- ✅ Input clearing after submission
- ✅ Form submission event handling

**BankDetailsModal Tests**
Location: `src/components/__tests__/BankDetailsModal.rapid-click.test.tsx`

Tests cover:

- ✅ Preventing duplicate payout confirmations
- ✅ Idempotency key inclusion in API requests
- ✅ Button disabled state while processing
- ✅ Logging suppressed attempts

**Pre-Submit Revalidation Tests**
Location: `src/components/__tests__/StellarFiatModal.revalidation.test.tsx`

Tests cover:

- ✅ Normal path: unchanged wallet/network/contract submits the XDR
- ✅ Aborts with recoverable message when wallet address changed
- ✅ Aborts with recoverable message when network passphrase changed
- ✅ Aborts with recoverable message when contract identity changed
- ✅ No XDR submitted on abort

## API Integration

### Idempotency Keys

All critical API endpoints should accept and respect the `X-Idempotency-Key` header:

```typescript
headers: {
  'Content-Type': 'application/json',
  'X-Idempotency-Key': idempotencyKey,
}
```

**Format:** `{action_name}_{timestamp}_{random_string}`

**Example:** `payout_confirm_1234567890_abc123def`

### Provider-accepted requests with timed-out responses

An initiation timeout after the provider connection is established is an
ambiguous outcome: the provider may already have accepted the transfer.
Recovery must query the provider using the original reference and credential
version. A missing status result is still ambiguous, not evidence that the
provider rejected the transfer, so it remains pending for later reconciliation.
Neither case is added to the automatic initiation retry queue; only a proven
pre-connection rejection may be retried.

The deterministic sandbox contract tests at
`src/lib/payout/providers/__tests__/sandboxAmbiguousOutcomes.test.ts` cover
accepted-but-timeout recovery, duplicate references, status-not-found, and
delayed webhook ordering. They assert that reconciliation does not resubmit an
accepted transfer and that ambiguous outcomes remain pending rather than being
marked failed.
