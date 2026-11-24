import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePayoutStatusAnnouncements } from '../usePayoutStatusAnnouncements';

type TestStatus = 'queued' | 'processing' | 'settled' | 'failed' | 'stale';

describe('usePayoutStatusAnnouncements (#291)', () => {
  it('announces a new transition once across re-renders and repeated polls', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        usePayoutStatusAnnouncements({
          reference: 'REF-291',
          status,
          at: '2026-11-24T10:00:00.000Z',
        }),
      { initialProps: { status: 'queued' as TestStatus } },
    );

    expect(result.current.announcement).toBe('Payout queued.');
    expect(result.current.history).toHaveLength(1);

    rerender({ status: 'queued' });
    rerender({ status: 'queued' });
    expect(result.current.announcement).toBe('Payout queued.');
    expect(result.current.history).toHaveLength(1);
  });

  it('appends distinct transitions to the reviewable history', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        usePayoutStatusAnnouncements({
          reference: 'REF-291',
          status,
          at: '2026-11-24T10:00:00.000Z',
        }),
      { initialProps: { status: 'queued' as TestStatus } },
    );

    rerender({ status: 'processing' });
    rerender({ status: 'settled' });

    expect(result.current.announcement).toBe('Payout settled.');
    expect(result.current.history.map((entry) => entry.status)).toEqual([
      'queued',
      'processing',
      'settled',
    ]);
  });

  it('announces stale data once and never downgrades a terminal result', () => {
    const { result, rerender } = renderHook(
      ({ status }) =>
        usePayoutStatusAnnouncements({ reference: 'REF-291', status }),
      { initialProps: { status: 'processing' as TestStatus } },
    );

    rerender({ status: 'stale' });
    rerender({ status: 'stale' });
    expect(result.current.announcement).toBe(
      'Payout status is out of date. Refresh before acting.',
    );
    expect(result.current.history).toHaveLength(2);

    rerender({ status: 'failed' });
    rerender({ status: 'stale' });
    expect(result.current.announcement).toBe('Payout failed.');
    expect(result.current.history).toHaveLength(3);
  });

  it('suppresses announcements while disabled and resets for a new transfer', () => {
    const { result, rerender } = renderHook(
      ({ reference, enabled }) =>
        usePayoutStatusAnnouncements({
          reference,
          status: 'queued',
          enabled,
        }),
      {
        initialProps: { reference: 'REF-1', enabled: false },
      },
    );

    expect(result.current.announcement).toBe('');
    expect(result.current.history).toHaveLength(0);

    rerender({ reference: 'REF-1', enabled: true });
    expect(result.current.announcement).toBe('Payout queued.');

    rerender({ reference: 'REF-2', enabled: true });
    expect(result.current.announcement).toBe('Payout queued.');
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].reference).toBe('REF-2');
  });
});
