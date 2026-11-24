# Freighter-Mocked Transitions (#273)

## Coverage

- **Account/network switch during signing**: `StellarWalletContext.signTx` validates live Freighter address/network against expected context and throws `WALLET_CONTEXT_CHANGED` before signing/submitting writes.
- **Wrong-network write block**: signing rejects when passphrase is not Stellar Testnet / expected context.
- **Account-scoped UI state clearing**: disconnect and account selection clear generic pending tx markers and account-scoped pending tx keys for the previous account; context version increments on account switch.

## Least-Privilege Permissions (#195)

- **Read-only vs. signing**: connecting only requests account access (`requestAccess` / `getAddress`). Transaction signing (`signTransaction`) is requested per action, at the moment a write is submitted — never bundled into connect.
- **Prompt explanation**: each permission prompt is explained in the UI at the point of request so the user knows whether they are granting read-only account access or authorizing a specific transaction signature.
- **Denial handling**: denying account access or a signing request leaves no partially authenticated session — the wallet stays disconnected (or the pending action is aborted) with a recoverable UI state and no stale connected markers.
- **Compatibility note**: this is an intentional behavior change from a blanket connect+sign flow; callers must request signing only when a write is actually submitted.

## Pre-Submit Revalidation (#196)

- **Re-check after confirmation**: immediately before submitting a signed XDR, the submission path re-reads the live wallet address, the network passphrase, and the configured contract identity, and compares them against the values captured when the user confirmed the action.
- **Fail closed on drift**: if any of the three values changed between confirmation and submission, submission is aborted before the XDR is sent. No transaction is broadcast and no pending-tx marker is left behind.
- **Recoverable message**: the abort surfaces a user-facing, recoverable message (e.g. wallet account or network changed — please review and retry) rather than a silent failure or a generic error.
- **Safety preserved**: double-submit protection and audit logging are unchanged; the revalidation runs inside the existing guarded submission path so a drifted context cannot bypass the single-submit lock.

## Transaction Recovery State Machine (#197)

- **Explicit typed states**: a transaction is modeled as one of `built`, `signed`, `submitted`, `pending`, `confirmed`, `failed`, `expired`. The state is a discriminated union so each state carries only the data valid for it.
- **Minimal persisted recovery data**: only the fields needed to resume or recover a transaction are persisted — the transaction hash (once known), the signed XDR (until confirmed/failed/expired), the account address, the network passphrase, the contract identity, and a timestamp. No secrets, keys, or unrelated UI state are stored.
- **Allowed transitions**: `built → signed → submitted → pending → confirmed | failed | expired`. `submitted → failed` and `pending → failed | expired` are permitted; terminal states (`confirmed`, `failed`, `expired`) have no outgoing transitions.
- **Impossible transitions are detectable**: transitions are guarded by a typed transition function that throws a typed `INVALID_TRANSITION` error (carrying `from`/`to`) instead of silently mutating state, so illegal moves surface in tests and at runtime.
- **Recovery on reload**: persisted state is rehydrated into the typed machine; a transaction left in `submitted`/`pending` past its expiry window is moved to `expired` rather than being re-broadcast, preserving single-submit safety.

## Tests

- `src/contexts/__tests__/walletContextTransitions.test.tsx`
  - account change during signing -> blocked, no `signTransaction`
  - wrong network before write -> blocked, no `signTransaction`
  - disconnect clears account-scoped pending tx UI state
- `src/contexts/__tests__/walletLeastPrivilege.test.tsx`
  - connect requests account access only, no `signTransaction`
  - denied account access -> no connected session, recoverable state
  - denied signing -> pending action aborted, no stale connected state
- `src/contexts/__tests__/walletPreSubmitRevalidation.test.tsx`
  - unchanged account/network/contract -> XDR submitted normally
  - account changed after confirmation -> submission aborted, recoverable message, no broadcast
  - network passphrase changed after confirmation -> submission aborted, recoverable message
  - contract identity changed after confirmation -> submission aborted, recoverable message
- `src/transactions/__tests__/transactionStateMachine.test.ts`
  - normal path: `built → signed → submitted → pending → confirmed`
  - failure path: `submitted → failed` and `pending → failed`
  - expiry/recovery path: persisted `pending` past expiry rehydrates as `expired`, not re-broadcast
  - authorization/guard path: illegal transitions (e.g. `built → confirmed`, `confirmed → pending`) throw typed `INVALID_TRANSITION` and leave state unchanged
  - persistence: only minimal recovery fields are serialized; terminal states drop the signed XDR

## Safety

- No credentials or real user data in fixtures.
- Existing financial safety checks preserved; wrong-context writes fail closed.
