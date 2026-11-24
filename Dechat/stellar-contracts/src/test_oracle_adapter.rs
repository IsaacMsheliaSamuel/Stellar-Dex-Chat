#![cfg(test)]

use crate::{
    oracle::{
        OracleAdapter, OracleAdapterClient, OracleAdapterConfig, OracleAdapterError,
        VersionedOracleObservation,
    },
    FiatBridge, FiatBridgeClient,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    vec, Address, Env,
};

#[contract]
pub struct VersionedFeedFixture;

#[contractimpl]
impl VersionedFeedFixture {
    pub fn set_observation(
        env: Env,
        token: Address,
        observation: Option<VersionedOracleObservation>,
    ) {
        env.storage().instance().set(&token, &observation);
    }

    pub fn get_observation(
        env: Env,
        token: Address,
    ) -> Option<VersionedOracleObservation> {
        env.storage().instance().get(&token).unwrap_or(None)
    }
}

fn observation(price: i128, decimals: u32, recorded_at: u32) -> VersionedOracleObservation {
    VersionedOracleObservation {
        version: 1,
        price,
        price_decimals: decimals,
        recorded_at,
        confidence: 100,
    }
}

fn config(max_spread_bps: u32) -> OracleAdapterConfig {
    OracleAdapterConfig {
        max_age_ledgers: 5,
        min_confidence: 10,
        min_sources: 2,
        max_spread_bps,
    }
}

#[test]
fn adapter_normalizes_decimals_and_returns_median() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.sequence_number = 100);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let source_a = env.register(VersionedFeedFixture, ());
    let source_b = env.register(VersionedFeedFixture, ());
    let source_c = env.register(VersionedFeedFixture, ());

    VersionedFeedFixtureClient::new(&env, &source_a).set_observation(
        &token,
        &Some(observation(100_000_000, 8, 100)),
    );
    VersionedFeedFixtureClient::new(&env, &source_b).set_observation(
        &token,
        &Some(observation(10_000_000, 7, 95)),
    );
    VersionedFeedFixtureClient::new(&env, &source_c).set_observation(
        &token,
        &Some(observation(99_500_000, 8, 100)),
    );

    let adapter_id = env.register(OracleAdapter, ());
    let adapter = OracleAdapterClient::new(&env, &adapter_id);
    adapter.init(
        &admin,
        &vec![&env, source_a, source_b, source_c],
        &config(100),
    );

    assert_eq!(adapter.get_aggregated_price(&token), Ok(10_000_000));
}

#[test]
fn adapter_rejects_stale_sources_and_excessive_spread() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.sequence_number = 100);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let source_a = env.register(VersionedFeedFixture, ());
    let source_b = env.register(VersionedFeedFixture, ());

    VersionedFeedFixtureClient::new(&env, &source_a).set_observation(
        &token,
        &Some(observation(10_000_000, 7, 94)),
    );
    VersionedFeedFixtureClient::new(&env, &source_b).set_observation(
        &token,
        &Some(observation(20_000_000, 7, 100)),
    );

    let adapter_id = env.register(OracleAdapter, ());
    let adapter = OracleAdapterClient::new(&env, &adapter_id);
    adapter.init(&admin, &vec![&env, source_a, source_b], &config(100));

    assert_eq!(
        adapter.get_aggregated_price(&token),
        Err(OracleAdapterError::TooFewSources)
    );
    VersionedFeedFixtureClient::new(&env, &source_a).set_observation(
        &token,
        &Some(observation(10_000_000, 7, 100)),
    );
    assert_eq!(
        adapter.get_aggregated_price(&token),
        Err(OracleAdapterError::SpreadTooWide)
    );
}

#[test]
fn adapter_returns_stable_version_and_overflow_errors() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.sequence_number = 100);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let source_a = env.register(VersionedFeedFixture, ());
    let source_b = env.register(VersionedFeedFixture, ());
    let feed_a = VersionedFeedFixtureClient::new(&env, &source_a);
    let feed_b = VersionedFeedFixtureClient::new(&env, &source_b);

    feed_a.set_observation(
        &token,
        &Some(VersionedOracleObservation {
            version: 2,
            price: 10_000_000,
            price_decimals: 7,
            recorded_at: 100,
            confidence: 100,
        }),
    );
    feed_b.set_observation(&token, &Some(observation(10_000_000, 7, 100)));

    let adapter_id = env.register(OracleAdapter, ());
    let adapter = OracleAdapterClient::new(&env, &adapter_id);
    adapter.init(&admin, &vec![&env, source_a.clone(), source_b.clone()], &config(100));
    assert_eq!(
        adapter.get_aggregated_price(&token),
        Err(OracleAdapterError::UnsupportedVersion)
    );

    feed_a.set_observation(
        &token,
        &Some(observation(i128::MAX, 0, 100)),
    );
    assert_eq!(
        adapter.get_aggregated_price(&token),
        Err(OracleAdapterError::ArithmeticOverflow)
    );
}

#[test]
fn oracle_failure_trip_cannot_reset_until_its_token_price_is_fresh() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.sequence_number = 100);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let source_a = env.register(VersionedFeedFixture, ());
    let source_b = env.register(VersionedFeedFixture, ());
    let feed_a = VersionedFeedFixtureClient::new(&env, &source_a);
    let feed_b = VersionedFeedFixtureClient::new(&env, &source_b);
    feed_a.set_observation(&token, &Some(observation(10_000_000, 7, 94)));
    feed_b.set_observation(&token, &Some(observation(10_000_000, 7, 94)));

    let adapter_id = env.register(OracleAdapter, ());
    OracleAdapterClient::new(&env, &adapter_id).init(
        &admin,
        &vec![&env, source_a, source_b],
        &config(100),
    );
    let bridge_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &bridge_id);
    bridge.init(
        &admin,
        &token,
        &100_000,
        &1,
        &vec![&env, admin.clone()],
        &1,
        &0,
    );
    bridge.set_oracle_adapter(&adapter_id);

    assert!(!bridge.check_oracle_health(&token));
    assert!(bridge.is_circuit_breaker_tripped());
    assert_eq!(
        bridge.try_reset_circuit_breaker(),
        Err(Ok(crate::Error::OraclePriceInvalid))
    );

    feed_a.set_observation(&token, &Some(observation(10_000_000, 7, 100)));
    feed_b.set_observation(&token, &Some(observation(10_000_000, 7, 100)));
    bridge.reset_circuit_breaker();
    assert!(!bridge.is_circuit_breaker_tripped());
}
