# Payout API Security Policy

## Overview

This document specifies the threat model, enforcement strategy, and cross-origin security guarantees for all fiat payout API routes in the Stellar-Dex-Chat application.

---

## 1. State-Changing Browser Routes

### Scope

- `POST /api/create-recipient`
- `POST /api/initiate-transfer`
- `POST /api/verify-account`
- `POST /api/transfer-status`

### Protection Controls

1. **Fetch Metadata (`Sec-Fetch-Site`)**:
   - Browser requests with `Sec-Fetch-Site: cross-site` are immediately rejected with `403 Forbidden` (`CROSS_SITE_REQUEST_FORBIDDEN`).
   - Only `same-origin`, `same-site`, or user-initiated (`none`) requests are permitted.

2. **Origin & Referer Validation**:
   - Browser requests containing an `Origin` or `Referer` header must match the configured allowlist (e.g., `NEXT_PUBLIC_APP_URL`, `ALLOWED_ORIGINS`, or application same-origin).
   - Requests from untrusted / hostile third-party origins are rejected with `403 Forbidden` (`FORBIDDEN_ORIGIN`).

3. **CSRF Token Strategy**:
   - Authenticated browser sessions (e.g., carrying session cookies) must include an HMAC-signed `X-CSRF-Token` header.
   - CSRF tokens are bound to session scope and timestamped with a 24-hour expiration.
   - Missing or tampered CSRF tokens on browser session requests are rejected with `403 Forbidden` (`CSRF_VALIDATION_FAILED`).

4. **Explicit CORS Behavior**:
   - `Access-Control-Allow-Origin` is strictly set to the validated caller origin.
   - **Wildcard Rejection**: `Access-Control-Allow-Origin: *` is NEVER emitted in conjunction with `Access-Control-Allow-Credentials: true`. Wildcard credentialed access is strictly prohibited.
   - Permitted methods: `GET, POST, OPTIONS`.
   - Permitted headers: `Content-Type, Authorization, X-CSRF-Token, X-Idempotency-Key, x-trace-id, x-span-id, sec-fetch-site`.

---

## 2. Wallet-Based and Programmatic Clients

### Policy

- Wallet clients (e.g., Freighter, mobile wallets, automated integration scripts, or server-to-server API callers) do not execute in an ambient browser cookie context and do not transmit browser-specific `Origin` or `Sec-Fetch-*` headers.
- **Safe Allowance**: Requests lacking `Origin`, `Referer`, and `Sec-Fetch-*` headers are classified as wallet/programmatic clients and are allowed to proceed to route handlers without blocking.
- State-changing actions are authenticated via cryptographic signatures (e.g., Stellar account signature or Bearer tokens) and idempotency keys rather than browser CSRF cookies.

---

## 3. Signed Provider Webhooks (`/api/webhook`)

### Separation from Browser Security

- Inbound webhooks from payout providers (e.g., Paystack) originate from external provider servers (server-to-server callbacks) and do not have browser sessions, same-origin headers, or CSRF tokens.
- Webhook routes are explicitly **exempt** from browser Origin, Fetch Metadata, and CSRF token requirements.

### Webhook Authentication Policy

1. **Cryptographic HMAC Signature Verification**:
   - Inbound webhook payloads must carry a valid `x-paystack-signature` header.
   - The server verifies the signature using `crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)`.
   - Signatures are compared using constant-time verification to prevent timing attacks.
   - Requests with missing or invalid signatures are rejected immediately with `401 Unauthorized`.
   - If `PAYSTACK_SECRET_KEY` is not configured, the endpoint fails closed with a `400 Bad Request`.

2. **Replay Protection and Event Ordering**:
   - Webhook deliveries are deduplicated by provider event ID; committed duplicates receive a successful acknowledgement without applying another payout transition.
   - The durable deduplication and event-order records use `PAYOUT_DATA_DIR` when configured. Deduplication records are retained for seven days by default, and abandoned in-flight processing locks expire after 30 seconds.
   - Provider event time and server receipt time are stored for each event. Events are ordered by provider time with stable status and event-ID tie-breakers, and the payout state is reconciled against that ordered history so delivery order does not determine the final state.
   - Terminal transitions are monotonic: delayed or contradictory events cannot downgrade a terminal payout state. Rejected events remain available for investigation.
    - The accessibility announcement layer follows the same ordering rule: a repeated or out-of-order status poll cannot re-announce or downgrade a settled/failed payout, and stale read-model data is announced as provisional rather than confirmed settlement (Issue #291).

## 4. Payout Traceability and Settlement Estimates

1. **Provider Idempotency**:
   - Each external transfer attempt stores its provider key, request fingerprint, expiration, and response reference in the durable provider idempotency registry.
   - `PAYSTACK_IDEMPOTENCY_WINDOW_MS` configures the Paystack key window (24 hours by default). A retry after expiration first reconciles the provider status; a new provider key is issued only after the provider confirms that no transfer exists.
   - Reusing an idempotency key with a different request is rejected.

2. **Reservation Ledger**:
   - When `contractReceiptId` is supplied to `POST /api/initiate-transfer`, the ledger links that receipt and reserved minor-unit amount to the payout, provider transfer reference, and its final settlement/release/review action.
   - Ledger entries are append-only and hash-linked. Duplicate settlement/release actions are idempotent, while conflicting receipt, amount, or provider-transfer links are rejected.
   - The ledger uses `PAYOUT_DATA_DIR` when configured. Configure this directory on persistent storage in deployments that require payout records to survive restarts.

3. **Settlement Estimate**:
   - Provider calendars define supported currencies, time zones, business days, non-processing dates, cutoff times, and settlement windows.
   - For configured currencies, `POST /api/initiate-transfer` includes a `settlementEstimate` with earliest/latest timestamps, timezone, and configuration source. Estimates are indicative windows, not a guarantee of settlement time.
