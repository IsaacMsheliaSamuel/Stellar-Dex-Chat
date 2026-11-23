import { describe, expect, it } from 'vitest';
import type { CalculationLineage } from '../../lineage/calculationLineage';
import {
  ALLOWED_PAYOUT_TRANSITIONS,
  InvalidPayoutTransitionError,
  MissingPayoutLineageError,
  attachPayoutLineage,
  canTransitionPayoutStatus,
  getPayoutLineage,
  isTerminalPayoutStatus,
  replayPayoutLifecycle,
  requiresPayoutLineage,
  validatePayoutTransition,
  type PayoutLifecycleRecord,
  type PayoutTransitionRecord,
} from '../payoutLifecycle';

const lineage: CalculationLineage = {
  calculationVersion: 'fx-payout-v1',
  inputSourceIds: ['synthetic-quote-1'],
  currencyMetadataVersion: 'currency-metadata-v1',
  roundingMode: 'half_up',
  roundingDelta: 1n,
  inputs: {
    grossAmount: 25,
    currency: 'USD',
    feePercentage: 0.015,
    providerFeeMinorUnits: 5000n,
    precisionDecimals: 2,
  },
};

const reference = 'synthetic_payout_transition_ref';

function transition(
  toStatus: PayoutTransitionRecord['toStatus'],
): PayoutTransitionRecord {
  return {
    fromStatus: 'none',
    toStatus,
    actor: 'system',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function emptyRecord(): PayoutLifecycleRecord {
  return { reference, status: 'initiated', transitions: [] };
}

describe('critical payout transition coverage', () => {
  it('allows documented normal paths and idempotent no-ops', () => {
    expect(canTransitionPayoutStatus('none', 'initiated')).toBe(true);
    expect(canTransitionPayoutStatus('initiated', 'pending')).toBe(true);
    expect(canTransitionPayoutStatus('pending', 'success')).toBe(true);
    expect(canTransitionPayoutStatus('success', 'reversed')).toBe(true);
    expect(canTransitionPayoutStatus('pending', 'pending')).toBe(true);

    const replayed = replayPayoutLifecycle(reference, [
      'initiated',
      'pending',
      'success',
    ]);
    expect(replayed.status).toBe('success');
    expect(replayed.history.map((entry) => entry.toStatus)).toEqual([
      'initiated',
      'pending',
      'success',
    ]);
  });

  it('keeps terminal states immutable', () => {
    for (const terminal of ['failed', 'reversed', 'cancelled'] as const) {
      expect(isTerminalPayoutStatus(terminal)).toBe(true);
      expect(ALLOWED_PAYOUT_TRANSITIONS[terminal]).toEqual([]);
      expect(canTransitionPayoutStatus(terminal, 'success')).toBe(false);
      expect(canTransitionPayoutStatus(terminal, 'pending')).toBe(false);
      expect(() =>
        validatePayoutTransition(terminal, 'success', reference),
      ).toThrow(InvalidPayoutTransitionError);
    }
  });

  it('rejects out-of-order settlement and invalid success shortcuts', () => {
    expect(canTransitionPayoutStatus('none', 'success')).toBe(false);
    expect(canTransitionPayoutStatus('cancelled', 'success')).toBe(false);
    expect(canTransitionPayoutStatus('success', 'failed')).toBe(false);

    expect(() =>
      replayPayoutLifecycle(reference, ['pending', 'cancelled', 'success']),
    ).toThrow(InvalidPayoutTransitionError);
  });

  it('requires lineage only for transitions that represent paid amounts', () => {
    expect(requiresPayoutLineage('initiated')).toBe(true);
    expect(requiresPayoutLineage('pending')).toBe(true);
    expect(requiresPayoutLineage('success')).toBe(true);
    expect(requiresPayoutLineage('reversed')).toBe(true);
    expect(requiresPayoutLineage('failed')).toBe(false);
    expect(requiresPayoutLineage('cancelled')).toBe(false);

    expect(() =>
      attachPayoutLineage(emptyRecord(), transition('success')),
    ).toThrow(MissingPayoutLineageError);
    expect(
      attachPayoutLineage(emptyRecord(), transition('failed')).status,
    ).toBe('failed');
  });

  it('prefers settlement lineage over initiation lineage when recovering', () => {
    const initiated = attachPayoutLineage(
      emptyRecord(),
      transition('initiated'),
      lineage,
    );
    const settled = attachPayoutLineage(initiated, transition('success'), {
      ...lineage,
      calculationVersion: 'fx-payout-v2-synthetic',
    });

    expect(getPayoutLineage(initiated)?.calculationVersion).toBe(
      'fx-payout-v1',
    );
    expect(getPayoutLineage(settled)?.calculationVersion).toBe(
      'fx-payout-v2-synthetic',
    );
    expect(settled.transitions).toHaveLength(2);
  });
});
