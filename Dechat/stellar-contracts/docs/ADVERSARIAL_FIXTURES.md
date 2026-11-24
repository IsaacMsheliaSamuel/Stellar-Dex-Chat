# Adversarial Token and Oracle Contract Fixtures

## 1. Overview and Objective

Smart contract integrations frequently encounter faulty, hostile, or misconfigured external contracts. Happy-path unit tests using standard tokens and benign oracles fail to model:
- Reverts during transfers or price lookups.
- Stale, zero, or negative price feeds.
- Extreme values causing overflow or unbounded slippage.
- Dynamic inconsistencies (e.g., frontrunning or rapid price shifts between expectation and settlement).

This specification documents:
1. Configurable mock contracts (`AdversarialToken` and `AdversarialOracle`).
2. Supported versus rejected external behaviors across deposit, withdrawal, fee, and migration flows.
3. Invariant guarantees: no partial accounting state survives external failure.

---

## 2. External Behavior Matrix

| External Dependency | Behavior Mode | Supported vs Rejected | Expected Contract Behavior | State Invariant |
|:---|:---|:---|:---|:---|
| **Price Oracle** | Returns valid positive price within slippage | Supported | Deposit / withdrawal settles normally | Accounting updated atomically |
| **Price Oracle** | Returns negative price (`price < 0`) | **Rejected** | Aborts with `Error::OraclePriceInvalid` | No receipt issued; balances unchanged |
| **Price Oracle** | Returns zero price (`price == 0`) | **Rejected** | Aborts with `Error::OraclePriceInvalid` | No receipt issued; balances unchanged |
| **Price Oracle** | Panics / reverts on `get_price` | **Rejected** | Transaction reverts | Host discards all state modifications |
| **Price Oracle** | Extreme price shift beyond `max_slippage` | **Rejected** | Aborts with `Error::SlippageExceeded` | Request remains queued; liabilities intact |
| **Token Contract** | Standard transfer success | Supported | Funds move; accounting updated | Total deposits / withdrawals match |
| **Token Contract** | Reverts on deposit transfer | **Rejected** | Returns `Error::TransferFailed` | No receipt or fiat valuation survives |
| **Token Contract** | Reverts on withdrawal transfer | **Rejected** | Returns `Error::TransferFailed` | Queue position preserved; liability intact |
| **Token Contract** | Reverts on fee withdrawal transfer | **Rejected** | Returns `Error::TransferFailed` | Fee remains accrued; nonce not burned |
| **Token Contract** | Requires transfer authorization | **Rejected** | Transfer invocation fails atomically | No balance or accounting delta |
| **Token Contract** | Returns a short or mismatched balance delta | **Rejected** | Returns `Error::ShortTransfer` or `Error::TransferFailed` | Deposit accounting and volume roll back |
| **Token Contract** | Uses non-seven decimal precision | Supported | Fiat value uses token `decimals()` | Receipt records precision and deposit-time value |
| **Token Contract** | Cannot answer balance or decimals query | **Rejected** | Returns `Error::TokenInterfaceInvalid` | No partial state or event survives |

---

## 3. Token Conformance Fixture

`src/test_token_conformance.rs` provides a configurable token fixture for
variable decimals, authorization-required transfers, transfer rejection, short
delivery, and normal balance changes. The tests exercise the bridge's checked
transfer boundary and verify that failed calls do not retain fiat-volume
updates. `src/test_oracle_adapter.rs` covers decimal normalization, freshness,
source count, spread bounds, and breaker recovery.

## 4. Atomic State Rollback Guarantee

A core invariant of the `FiatBridge` protocol is transactional atomicity:
- If a dependency reverts at any point during execution, the host environment rolls back all storage writes and event emissions.
- When an operation returns a handled `Err(Error::...)`, the contract does not mutate accumulators, burn nonces, or drop queued items.
- In tests, state invariants (`total_deposited`, `total_withdrawn`, `total_liabilities`, `queue_len`, `nonces`) are verified before and after each adversarial scenario to ensure zero state corruption.
