#![cfg(test)]

use crate::{Error, FiatBridge, FiatBridgeClient};
use soroban_sdk::{testutils::Address as _, token, vec, Address, Bytes, Env};

#[test]
fn disabled_token_still_settles_liabilities_before_removal() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let default_token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let other_token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);
    bridge.init(
        &admin,
        &default_token,
        &1_000_000,
        &1,
        &vec![&env, admin.clone()],
        &1,
        &0,
    );
    bridge.register_token(&other_token, &1_000_000, &7);

    let user = Address::generate(&env);
    let token_admin = token::StellarAssetClient::new(&env, &other_token);
    token_admin.mint(&user, &100);
    bridge.deposit(
        &user,
        &100,
        &other_token,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );

    bridge.set_token_deposits_enabled(&other_token, &false);
    let rejected = bridge.try_deposit(
        &user,
        &1,
        &other_token,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );
    assert_eq!(rejected, Err(Ok(Error::TokenDepositsDisabled)));

    let request_id =
        bridge.request_withdrawal(&user, &100, &other_token, &None, &0);
    assert_eq!(
        bridge.try_remove_token(&other_token),
        Err(Ok(Error::TokenNotRetirable))
    );

    env.ledger()
        .set_sequence_number(env.ledger().sequence().saturating_add(2));
    let nonce = bridge.get_withdrawal_execution_nonce(&user);
    bridge.execute_withdrawal(&request_id, &None, &0, &0, &nonce);
    bridge.migrate_escrow(&1);

    let readiness = bridge
        .get_token_retirement_readiness(&other_token);
    assert!(!readiness.deposits_enabled);
    assert_eq!(readiness.total_liabilities, 0);
    assert_eq!(readiness.net_deposited, 0);
    assert_eq!(readiness.fee_remainder, 0);
    assert!(readiness.escrow_migration_complete);
    assert!(readiness.can_remove);

    bridge.remove_token(&other_token);
    assert_eq!(
        bridge.try_get_token_retirement_readiness(&other_token),
        Err(Ok(Error::TokenNotWhitelisted))
    );
    assert_eq!(bridge.get_wq_depth(), 0);
}
