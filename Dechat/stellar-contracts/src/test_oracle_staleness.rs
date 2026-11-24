//! Regression coverage for versioned oracle observation validation.

extern crate std;

use crate::oracle::{
    validate_observation, OracleConfig, OracleError, OracleObservation,
};
use soroban_sdk::{testutils::Address as _, Env};

fn observation(recorded_at: u32, confidence: i128) -> OracleObservation {
    OracleObservation {
        price: 10_000_000,
        recorded_at,
        confidence,
    }
}

#[test]
fn observation_at_freshness_boundary_is_accepted() {
    let env = Env::default();
    let oracle = soroban_sdk::Address::generate(&env);
    let config = OracleConfig {
        max_age_ledgers: 5,
        min_confidence: 10,
    };

    assert!(validate_observation(
        &env,
        &oracle,
        Some(observation(95, 10)),
        &config,
        100,
    )
    .is_ok());
}

#[test]
fn stale_future_missing_and_low_confidence_observations_are_rejected() {
    let env = Env::default();
    let oracle = soroban_sdk::Address::generate(&env);
    let config = OracleConfig {
        max_age_ledgers: 5,
        min_confidence: 10,
    };

    assert_eq!(
        validate_observation(&env, &oracle, Some(observation(94, 10)), &config, 100),
        Err(OracleError::OracleStale)
    );
    assert_eq!(
        validate_observation(&env, &oracle, Some(observation(101, 10)), &config, 100),
        Err(OracleError::OracleFutureDated)
    );
    assert_eq!(
        validate_observation(&env, &oracle, None, &config, 100),
        Err(OracleError::OracleMissing)
    );
    assert_eq!(
        validate_observation(&env, &oracle, Some(observation(100, 9)), &config, 100),
        Err(OracleError::OracleLowConfidence)
    );
}
