#![cfg(test)]

use crate::{Address, Bytes, Env, Error, FiatBridge, FiatBridgeClient};
use soroban_sdk::{contract, contractimpl, testutils::Address as _, vec};

#[contract]
pub struct VariableDecimalToken;

#[contractimpl]
impl VariableDecimalToken {
    pub fn set_decimals(env: Env, decimals: u32) {
        env.storage().instance().set(&1u32, &decimals);
    }

    pub fn set_transfer_mode(env: Env, mode: u32) {
        env.storage().instance().set(&2u32, &mode);
    }

    pub fn mint(env: Env, address: Address, amount: i128) {
        let balance = Self::balance(env.clone(), address.clone());
        env.storage()
            .instance()
            .set(&address, &(balance + amount));
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&1u32).unwrap_or(7)
    }

    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage().instance().get(&address).unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let mode: u32 = env.storage().instance().get(&2u32).unwrap_or(0);
        if mode == 1 {
            panic!("fixture transfer rejected");
        }
        let from_balance = Self::balance(env.clone(), from.clone());
        if amount <= 0 || from_balance < amount {
            panic!("fixture insufficient balance");
        }
        let delivered = if mode == 2 { amount - 1 } else { amount };
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&from, &(from_balance - amount));
        env.storage()
            .instance()
            .set(&to, &(to_balance + delivered));
    }
}

#[contract]
pub struct FixedPriceFixture;

#[contractimpl]
impl FixedPriceFixture {
    pub fn set_price(env: Env, token: Address, price: Option<i128>) {
        env.storage().instance().set(&token, &price);
    }

    pub fn get_price(env: Env, token: Address) -> Option<i128> {
        env.storage().instance().get(&token).unwrap_or(None)
    }
}

fn setup(env: &Env) -> (FiatBridgeClient<'_>, Address, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token_id = env.register(VariableDecimalToken, ());
    VariableDecimalTokenClient::new(env, &token_id).set_decimals(&6);
    let oracle_id = env.register(FixedPriceFixture, ());
    FixedPriceFixtureClient::new(env, &oracle_id)
        .set_price(&token_id, &Some(10_000_000));
    let bridge_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &bridge_id);
    bridge.init(
        &admin,
        &token_id,
        &100_000_000,
        &1,
        &vec![env, admin.clone()],
        &1,
        &0,
    );
    bridge.set_oracle(&oracle_id);
    bridge.set_fiat_limit(&1_000);
    (bridge, admin, token_id, oracle_id)
}

#[test]
fn fiat_volume_uses_token_decimals_and_persists_deposit_valuation() {
    let env = Env::default();
    let (bridge, _, token_id, oracle_id) = setup(&env);
    let user = Address::generate(&env);
    VariableDecimalTokenClient::new(&env, &token_id).mint(&user, &20_000_000);

    let receipt_id = bridge.deposit(&user, &10_000_000, &token_id, &Bytes::new(&env), &0, &0, &None);

    assert_eq!(bridge.get_user_fiat_volume(&user), 1_000);
    FixedPriceFixtureClient::new(&env, &oracle_id)
        .set_price(&token_id, &Some(20_000_000));
    assert_eq!(
        bridge.get_receipt_fiat_valuation(&receipt_id),
        Some(crate::FiatValuation {
            version: 1,
            token_amount: 10_000_000,
            token_decimals: 6,
            oracle: oracle_id,
            adapter_version: 0,
            price: 10_000_000,
            usd_cents: 1_000,
            ledger: env.ledger().sequence(),
            fiat_window_ledgers: 17_280,
            user_limit: Some(1_000),
            user_volume_before: Some(0),
            user_volume_after: Some(1_000),
            user_window_start: Some(env.ledger().sequence()),
            global_limit: None,
            global_volume_before: None,
            global_volume_after: None,
            global_window_start: None,
        })
    );
}

#[test]
fn rejected_and_short_token_transfers_roll_back_volume_updates() {
    let env = Env::default();
    let (bridge, _, token_id, _) = setup(&env);
    let user = Address::generate(&env);
    let token = VariableDecimalTokenClient::new(&env, &token_id);
    token.mint(&user, &20_000_000);

    token.set_transfer_mode(&2);
    assert_eq!(
        bridge.try_deposit(&user, &10_000_000, &token_id, &Bytes::new(&env), &0, &0, &None),
        Err(Ok(Error::ShortTransfer))
    );
    assert_eq!(bridge.get_user_fiat_volume(&user), 0);

    token.set_transfer_mode(&1);
    assert_eq!(
        bridge.try_deposit(&user, &10_000_000, &token_id, &Bytes::new(&env), &0, &0, &None),
        Err(Ok(Error::TransferFailed))
    );
    assert_eq!(bridge.get_user_fiat_volume(&user), 0);
}

#[test]
fn token_fixture_rejects_unauthorized_transfers() {
    let env = Env::default();
    let token_id = env.register(VariableDecimalToken, ());
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    assert!(VariableDecimalTokenClient::new(&env, &token_id)
        .try_transfer(&from, &to, &1)
        .is_err());
}
