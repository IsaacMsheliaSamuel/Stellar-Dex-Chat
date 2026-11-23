# Contract ABI drift runbook

Use this runbook when `pnpm contract:abi:check` or the frontend CI ABI check
fails. The check compares:

- committed method names in `src/contracts/types.ts` (`FIAT_BRIDGE_METHODS`);
- committed error codes in the same file (`FiatBridgeErrorCode`);
- committed DTO interfaces in the same file;
- committed method signatures in `src/contracts/abi/fiat_bridge_abi.json`;
- Soroban spec snapshots listed in `src/contracts/abi/specs/manifest.json`.

The `current` release must match the bindings exactly. Supported older
releases may be a subset of the current client, but any method, signature,
error code, or field they require must still be present.

## 1. Read the diff

The checker prints a unified-style diff:

```text
--- expected: Soroban contract spec
+++ actual: committed TypeScript client bindings
@@ current (current) method deposit signature-mismatch @@
- Address, i128 -> Result<(), Error>
+ Address -> Result<(), Error>
```

`expected` is the Soroban spec; `actual` is the committed TypeScript binding.
The release id and status show whether the drift is against the current build
or a supported baseline.

## 2. Classify the drift

| Kind                            | Meaning                                       | Safe response                                                           |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `missing-method`                | Spec requires a method the client lacks       | Add the method to `FIAT_BRIDGE_METHODS` and implement its typed wrapper |
| `extra-method`                  | Client has a method the current spec lacks    | Remove or gate the stale binding                                        |
| `signature-mismatch`            | Committed ABI signature differs from the spec | Regenerate the ABI fixture and client encoding                          |
| `error-mismatch`                | Error code/name differs                       | Update `FiatBridgeErrorCode` and mapping together                       |
| `missing-field` / `extra-field` | DTO fields differ from spec                   | Update the DTO and all call sites                                       |
| `field-type-mismatch`           | DTO field type is incompatible                | Update encoding/decoding with tests                                     |

Do not silence the check by deleting a release from the manifest. Removing a
supported baseline is an explicit compatibility decision and must be called
out in the PR description.

## 3. Refresh a real spec when a contract build is available

```sh
cd Dechat/dex_with_fiat_frontend
RUSTUP_TOOLCHAIN=1.91.0 cargo build --manifest-path ../stellar-contracts/Cargo.toml --target wasm32-unknown-unknown --release
pnpm contract:abi:capture --release current --status current \
  --wasm ../stellar-contracts/target/wasm32-unknown-unknown/release/dex_contract.wasm \
  --output src/contracts/abi/specs/current.json
pnpm contract:abi:check
```

Replace the WASM filename with the actual contract artifact. If the contract
does not build, keep the committed snapshot and document the blocker; never
fabricate a spec snapshot.

## 4. Add a supported baseline

Capture the old ABI/spec into a new snapshot and append it to the manifest as
`status: "supported"`. The checker intentionally ignores methods and fields
that only exist in newer releases, so additive changes do not fail older
baselines.

## 5. Escalate

If the diff implies a breaking financial behavior change—amount precision,
fee handling, escrow receipt identity, withdrawal quota semantics, or error
classification—stop and escalate for review before updating the bindings.
Never widen a type or drop a field just to make the check pass.
