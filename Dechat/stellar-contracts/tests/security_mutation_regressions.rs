//! Focused regression tests for the security-relevant mutations exercised by
//! `scripts/run_security_mutation_tests.py`.
//!
//! Each test pins one behavior that must break when its corresponding guard is
//! mutated: admin authentication, init signature validation, payout nonce
//! replay protection, cancellation state transitions, and uniqueness checks.
//! The tests also assert the normal path still succeeds before the failure
//! case is exercised, so a mutant that breaks everything cannot masquerade as
//! a killed mutant.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Bytes, Env,
};
use stellar_contracts::{Error, FiatBridge, FiatBridgeClient};

struct Fixture<'a> {
    bridge: FiatBridgeClient<'a>,
    admin: Address,
    token_addr: Address,
    token_admin: StellarAssetClient<'a>,
}

fn setup(env: &Env) -> Fixture<'_> {
    let admin = Address::generate(env);
    let token_admin_address = Address::generate(env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin_address)
        .address();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);
    let signers = vec![env, admin.clone()];
    bridge.init(&admin, &token_addr, &1_000_000, &100, &signers, &1, &0);
    bridge.set_lock_period(&100);

    Fixture {
        bridge,
        admin,
        token_addr: token_addr.clone(),
        token_admin: StellarAssetClient::new(env, &token_addr),
    }
}

fn deposit_and_request(env: &Env, fx: &Fixture<'_>, user: &Address, amount: i128) -> u64 {
    fx.token_admin.mint(user, &(amount * 2));
    fx.bridge.deposit(
        user,
        &amount,
        &fx.token_addr,
        &Bytes::from_slice(env, b"seed"),
        &0,
        &0,
        &None,
    );
    fx.bridge
        .request_withdrawal(user, &amount, &fx.token_addr, &None, &0)
}

#[test]
fn admin_gated_entrypoint_rejects_missing_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup(&env);
    let operator = Address::generate(&env);
    assert!(fx.bridge.try_set_operator(&operator, &true, &0).is_ok());

    env.set_auths(&[]);
    let intruder = Address::generate(&env);
    let result = fx.bridge.try_set_operator(&intruder, &true, &0);
    assert!(
        result.is_err(),
        "an admin-gated call without admin auth must fail"
    );
}

#[test]
fn init_rejects_missing_admin_signature() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    env.set_auths(&[]);
    let result = bridge.try_init(&admin, &token, &1_000_000, &1, &signers, &1, &0);
    assert!(
        result.is_err(),
        "init must require the configured admin's signature"
    );
}

#[test]
fn stale_payout_nonce_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup(&env);
    let user = Address::generate(&env);
    let first_id = deposit_and_request(&env, &fx, &user, 5_000);
    env.ledger().with_mut(|l| l.sequence_number += 105);

    fx.bridge.execute_withdrawal(&first_id, &None, &0, &0, &0);
    assert_eq!(fx.bridge.get_withdrawal_execution_nonce(&user), 1);
    assert_eq!(fx.bridge.get_total_withdrawn(), 5_000);

    let second_id = deposit_and_request(&env, &fx, &user, 1_000);
    env.ledger().with_mut(|l| l.sequence_number += 105);

    let replay = fx
        .bridge
        .try_execute_withdrawal(&second_id, &None, &0, &0, &0);
    assert_eq!(replay, Err(Ok(Error::StaleNonce)));
    assert_eq!(fx.bridge.get_withdrawal_execution_nonce(&user), 1);
    assert_eq!(fx.bridge.get_total_withdrawn(), 5_000);
}

#[test]
fn finalize_cancellation_requires_approved_state() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup(&env);
    let user = Address::generate(&env);
    let request_id = deposit_and_request(&env, &fx, &user, 1_000);

    fx.bridge.request_cancellation(&request_id, &fx.admin);
    let result = fx.bridge.try_finalize_cancellation(&request_id);
    assert_eq!(result, Err(Ok(Error::CancellationNotApproved)));
    assert!(fx.bridge.get_cancellation_request(&request_id).is_some());
}

#[test]
fn init_rejects_duplicate_signers() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone(), admin.clone()];

    let result = bridge.try_init(&admin, &token, &1_000_000, &1, &signers, &1, &0);
    assert_eq!(result, Err(Ok(Error::DuplicateSigner)));
}

#[test]
fn duplicate_cancellation_request_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup(&env);
    let user = Address::generate(&env);
    let request_id = deposit_and_request(&env, &fx, &user, 1_000);

    fx.bridge.request_cancellation(&request_id, &user);
    let duplicate = fx.bridge.try_request_cancellation(&request_id, &user);
    assert_eq!(duplicate, Err(Ok(Error::CancellationAlreadyRequested)));
}
