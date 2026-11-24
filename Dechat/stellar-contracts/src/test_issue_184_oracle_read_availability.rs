#![cfg(test)]

use crate::oracle::{ObservationOracle, OracleObservation};
use crate::{Error, FiatBridge, FiatBridgeClient, OracleReadStatus};
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, token, vec, Address, Bytes, Env,
};

#[contract]
struct StaleOracle;

#[contractimpl]
impl ObservationOracle for StaleOracle {
    fn get_observation(env: Env, _token: Address) -> Option<OracleObservation> {
        Some(OracleObservation {
            price: 10_000_000,
            recorded_at: 1,
            confidence: 1,
        })
    }
}

#[contract]
struct UnavailableOracle;

#[contractimpl]
impl ObservationOracle for UnavailableOracle {
    fn get_observation(_env: Env, _token: Address) -> Option<OracleObservation> {
        panic!("oracle unavailable")
    }
}

fn setup(env: &Env) -> (FiatBridgeClient<'_>, Address, token::StellarAssetClient<'_>) {
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);
    bridge.init(
        &admin,
        &token_id,
        &1_000_000,
        &1,
        &vec![env, admin.clone()],
        &1,
        &0,
    );
    (
        bridge,
        token_id.clone(),
        token::StellarAssetClient::new(env, &token_id),
    )
}

#[test]
fn stale_oracle_is_diagnosable_and_fails_price_sensitive_deposits() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    let (bridge, token_id, token_admin) = setup(&env);
    let user = Address::generate(&env);
    token_admin.mint(&user, &100);

    let oracle = env.register(StaleOracle, ());
    bridge.set_oracle(&oracle);
    bridge.set_oracle_config(&oracle, &1, &1);
    bridge.set_fiat_limit(&100_000);

    let health = bridge.get_oracle_health(&token_id);
    assert_eq!(health.status, OracleReadStatus::Stale);
    assert_eq!(health.observed_at, Some(1));
    assert_eq!(bridge.get_total_deposited(), 0);

    let result =
        bridge.try_deposit(&user, &100, &token_id, &Bytes::new(&env), &0, &0, &None);
    assert_eq!(result, Err(Ok(Error::OracleObservationStale)));
    assert_eq!(bridge.get_total_deposited(), 0);
}

#[test]
fn unavailable_oracle_returns_health_and_a_distinct_mutation_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, token_id, token_admin) = setup(&env);
    let user = Address::generate(&env);
    token_admin.mint(&user, &100);

    let oracle = env.register(UnavailableOracle, ());
    bridge.set_oracle(&oracle);

    let health = bridge.get_oracle_health(&token_id);
    assert_eq!(health.status, OracleReadStatus::Unavailable);

    let result = bridge.try_deposit(
        &user,
        &100,
        &token_id,
        &Bytes::new(&env),
        &10_000_000,
        &100,
        &None,
    );
    assert_eq!(result, Err(Ok(Error::OracleUnavailable)));
    assert_eq!(bridge.get_total_deposited(), 0);
}
