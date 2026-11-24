#![cfg(test)]
use crate::{
    DataKey, Error, FiatBridge, FiatBridgeClient, ESCROW_STORAGE_VERSION,
    MAX_ESCROW_MIGRATION_BATCH_SIZE,
};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};

fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (
    soroban_sdk::token::Client<'a>,
    soroban_sdk::token::StellarAssetClient<'a>,
) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    (
        soroban_sdk::token::Client::new(env, &contract_address.address()),
        soroban_sdk::token::StellarAssetClient::new(env, &contract_address.address()),
    )
}

fn setup_bridge(
    env: &Env,
) -> (
    FiatBridgeClient<'_>,
    Address,
    Address,
    soroban_sdk::token::StellarAssetClient<'_>,
) {
    let admin = Address::generate(env);
    let (token_client, token_admin) = create_token_contract(env, &admin);
    let token_addr = token_client.address.clone();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);

    bridge.init(
        &admin,
        &token_addr,
        &1_000_000,
        &100,
        &soroban_sdk::vec![env, admin.clone()],
        &1,
        &0,
    );

    (bridge, admin, token_addr, token_admin)
}

#[test]
fn test_migrate_escrow_invariants() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_bridge(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    token_admin.mint(&user1, &500);
    token_admin.mint(&user2, &1000);

    let deposit1_amount = 100i128;
    let deposit2_amount = 250i128;
    let deposit3_amount = 350i128;

    bridge.deposit(
        &user1,
        &deposit1_amount,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );
    bridge.deposit(
        &user2,
        &deposit2_amount,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );
    bridge.deposit(
        &user1,
        &deposit3_amount,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );

    // Total receipts = 3

    // Empty and oversized batches are rejected without advancing the cursor.
    assert_eq!(
        bridge.try_migrate_escrow(&0),
        Err(Ok(Error::InvalidPageSize))
    );
    assert_eq!(
        bridge.try_migrate_escrow(&(MAX_ESCROW_MIGRATION_BATCH_SIZE + 1)),
        Err(Ok(Error::InvalidPageSize))
    );
    assert_eq!(bridge.get_migration_cursor(), 0);

    // exact-fit batches (batch size 1)
    let migrated_one = bridge.migrate_escrow(&1);
    assert_eq!(migrated_one, 1);
    assert_eq!(bridge.get_migration_cursor(), 1);

    // check version bump has NOT occurred yet
    let version: u32 = env.as_contract(&bridge.address, || {
        env.storage()
            .instance()
            .get(&DataKey::EscrowStorageVersion)
            .unwrap_or(0)
    });
    assert_ne!(version, ESCROW_STORAGE_VERSION);

    // resumable migration (batch size 2 to finish the 3 items)
    let migrated_two = bridge.migrate_escrow(&2);
    assert_eq!(migrated_two, 2);
    assert_eq!(bridge.get_migration_cursor(), 3);

    // confirm version bump occurred exactly when cursor == ReceiptCounter
    let version_after: u32 = env.as_contract(&bridge.address, || {
        env.storage()
            .instance()
            .get(&DataKey::EscrowStorageVersion)
            .unwrap_or(0)
    });
    assert_eq!(version_after, ESCROW_STORAGE_VERSION);

    // MigrationAlreadyComplete on subsequent call
    let err = bridge.try_migrate_escrow(&1);
    assert_eq!(err, Err(Ok(Error::MigrationAlreadyComplete)));

    // conservation check: sum of migrated == sum of receipts
    let escrow0 = bridge.get_escrow_record(&0).unwrap();
    let escrow1 = bridge.get_escrow_record(&1).unwrap();
    let escrow2 = bridge.get_escrow_record(&2).unwrap();

    assert_eq!(escrow0.amount, deposit1_amount);
    assert_eq!(escrow1.amount, deposit2_amount);
    assert_eq!(escrow2.amount, deposit3_amount);

    assert_eq!(
        escrow0.amount + escrow1.amount + escrow2.amount,
        deposit1_amount + deposit2_amount + deposit3_amount
    );
}

#[test]
fn test_set_migration_cursor_bounds_and_interaction() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_bridge(&env);

    // Input bounds
    assert_eq!(
        bridge.try_set_migration_cursor(&0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        bridge.try_set_migration_cursor(&-1),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        bridge.try_set_migration_cursor(&i128::MAX),
        Err(Ok(Error::InvalidAmount))
    );

    let user1 = Address::generate(&env);
    token_admin.mint(&user1, &500);
    bridge.deposit(&user1, &100, &token_addr, &Bytes::new(&env), &0, &0, &None);
    bridge.deposit(&user1, &100, &token_addr, &Bytes::new(&env), &0, &0, &None);
    bridge.deposit(&user1, &100, &token_addr, &Bytes::new(&env), &0, &0, &None);

    // A cursor cannot skip records that have not been migrated.
    assert_eq!(
        bridge.try_set_migration_cursor(&1),
        Err(Ok(Error::MigrationInvalidState))
    );
    assert_eq!(bridge.get_migration_cursor(), 0);

    assert_eq!(bridge.migrate_escrow(&1), 1);
    assert_eq!(bridge.get_migration_cursor(), 1);
    assert_eq!(bridge.try_set_migration_cursor(&1), Ok(Ok(())));
    assert_eq!(bridge.migrate_escrow(&2), 2);
    assert_eq!(bridge.get_migration_cursor(), 3);
}

#[test]
fn malformed_legacy_receipt_does_not_advance_or_replace_old_schema() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);
    token_admin.mint(&user, &100);
    bridge.deposit(&user, &100, &token_addr, &Bytes::new(&env), &0, &0, &None);
    let old_receipt = bridge.get_receipt_by_index(&0).unwrap();

    env.as_contract(&bridge.address, || {
        env.storage().temporary().remove(&DataKey::ReceiptIndex(0));
    });

    assert_eq!(
        bridge.try_migrate_escrow(&1),
        Err(Ok(Error::MigrationInvalidState))
    );
    assert_eq!(bridge.get_migration_cursor(), 0);
    assert_eq!(bridge.get_escrow_storage_version(), 0);
    assert_eq!(
        env.as_contract(&bridge.address, || {
            env.storage()
                .persistent()
                .has(&DataKey::Receipt(old_receipt.id))
        }),
        true
    );
    assert_eq!(bridge.get_escrow_record(&0), None);
}

#[test]
fn future_schema_version_is_rejected_without_overwriting_it() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, _token_addr, _token_admin) = setup_bridge(&env);
    let future_version = ESCROW_STORAGE_VERSION + 1;

    env.as_contract(&bridge.address, || {
        env.storage()
            .instance()
            .set(&DataKey::EscrowStorageVersion, &future_version);
    });

    assert_eq!(
        bridge.try_migrate_escrow(&1),
        Err(Ok(Error::MigrationSchemaMismatch))
    );
    assert_eq!(bridge.get_escrow_storage_version(), future_version);
    assert_eq!(bridge.get_migration_cursor(), 0);
}
