import { describe, expect, it } from 'vitest';
import {
  PAYOUT_ANNOUNCEMENT_MESSAGES,
  MAX_PAYOUT_ANNOUNCEMENT_HISTORY,
  buildPayoutAnnouncement,
  createPayoutAnnouncementState,
  mapPayoutLifecycleStatus,
  payoutAnnouncementKey,
  reducePayoutAnnouncements,
  type PayoutAnnouncementInput,
  type PayoutAnnouncementStatus,
} from '../payoutStatusAnnouncements';

const update = (
  status: PayoutAnnouncementStatus,
  overrides: Partial<PayoutAnnouncementInput> = {},
): PayoutAnnouncementInput => ({
  reference: 'REF-291',
  status,
  at: '2026-11-24T10:00:00.000Z',
  ...overrides,
});

function reduceAll(inputs: PayoutAnnouncementInput[]) {
  return inputs.reduce(
    (state, input) => reducePayoutAnnouncements(state, input),
    createPayoutAnnouncementState(inputs[0]?.reference ?? ''),
  );
}

describe('payoutStatusAnnouncements (#291)', () => {
  it('defines one concise message for each of the five states', () => {
    expect(PAYOUT_ANNOUNCEMENT_MESSAGES).toEqual({
      queued: 'Payout queued.',
      processing: 'Payout processing.',
      settled: 'Payout settled.',
      failed: 'Payout failed.',
      stale: 'Payout status is out of date. Refresh before acting.',
    });
    for (const message of Object.values(PAYOUT_ANNOUNCEMENT_MESSAGES)) {
      expect(message.length).toBeLessThan(80);
    }
  });

  it('does not repeat an identical transition from repeated polling', () => {
    const first = reducePayoutAnnouncements(
      createPayoutAnnouncementState(),
      update('queued'),
    );
    const second = reducePayoutAnnouncements(first, update('queued'));

    expect(second).toBe(first);
    expect(second.history).toHaveLength(1);
    expect(second.current?.message).toBe('Payout queued.');
  });

  it('announces each distinct transition and records an ordered history', () => {
    const state = reduceAll([
      update('queued'),
      update('processing', { at: '2026-11-24T10:00:01.000Z' }),
      update('settled', { at: '2026-11-24T10:00:02.000Z' }),
    ]);

    expect(state.current?.message).toBe('Payout settled.');
    expect(state.history.map((entry) => entry.status)).toEqual([
      'queued',
      'processing',
      'settled',
    ]);
    expect(state.history.map((entry) => entry.at)).toEqual([
      '2026-11-24T10:00:00.000Z',
      '2026-11-24T10:00:01.000Z',
      '2026-11-24T10:00:02.000Z',
    ]);
  });

  it('does not move a payout backwards to queued', () => {
    const processing = reducePayoutAnnouncements(
      createPayoutAnnouncementState(),
      update('processing'),
    );
    const afterLateQueued = reducePayoutAnnouncements(
      processing,
      update('queued'),
    );

    expect(afterLateQueued).toBe(processing);
  });

  it('keeps terminal states final when delayed or stale updates arrive', () => {
    for (const terminal of ['settled', 'failed'] as const) {
      const settledState = reducePayoutAnnouncements(
        createPayoutAnnouncementState(),
        update(terminal),
      );

      for (const late of ['queued', 'processing', 'stale'] as const) {
        expect(reducePayoutAnnouncements(settledState, update(late))).toBe(
          settledState,
        );
      }
    }
  });

  it('announces stale status once and allows recovery to move forward', () => {
    let state = reducePayoutAnnouncements(
      createPayoutAnnouncementState(),
      update('processing'),
    );
    state = reducePayoutAnnouncements(state, update('stale'));
    expect(state.current?.message).toBe(
      'Payout status is out of date. Refresh before acting.',
    );

    // Another poll with the same stale projection must not re-announce.
    expect(reducePayoutAnnouncements(state, update('stale'))).toBe(state);

    // A fresh poll may resume processing, but never restart at queued.
    expect(reducePayoutAnnouncements(state, update('queued'))).toBe(state);
    state = reducePayoutAnnouncements(state, update('settled'));
    expect(state.current?.message).toBe('Payout settled.');
  });

  it('starts a new history for a new transfer reference', () => {
    let state = reducePayoutAnnouncements(
      createPayoutAnnouncementState(),
      update('settled'),
    );
    state = reducePayoutAnnouncements(
      state,
      update('queued', { reference: 'REF-292' }),
    );

    expect(state.reference).toBe('REF-292');
    expect(state.history.map((entry) => entry.status)).toEqual(['queued']);
  });

  it('bounds the reviewable history during long polling sessions', () => {
    const inputs: PayoutAnnouncementInput[] = [update('queued')];
    for (let i = 0; i < MAX_PAYOUT_ANNOUNCEMENT_HISTORY + 10; i += 1) {
      inputs.push(update(i % 2 === 0 ? 'stale' : 'processing'));
    }
    const state = reduceAll(inputs);

    expect(state.history).toHaveLength(MAX_PAYOUT_ANNOUNCEMENT_HISTORY);
    expect(state.history.at(-1)?.status).toBe(inputs.at(-1)?.status);
  });

  it('sanitizes failure details and never exposes secrets or account numbers', () => {
    // Synthetic shapes only — no real keys or user data.
    const secret = `S${'A'.repeat(55)}`;
    const fakePat = 'ghp_SYNTHETICTOKENFORREDACTIONTESTS';
    const message = buildPayoutAnnouncement({
      status: 'failed',
      detail: `Provider rejected account 012345678901 with ${secret} and ${fakePat}`,
    });

    expect(message).toContain('Payout failed.');
    expect(message).not.toContain(secret);
    expect(message).not.toContain(fakePat);
    expect(message).not.toMatch(/\d{8,}/);
    expect(message.length).toBeLessThan(140);
  });

  it('does not append details to non-failure announcements', () => {
    expect(
      buildPayoutAnnouncement({ status: 'settled', detail: 'REF-1' }),
    ).toBe('Payout settled.');
    expect(payoutAnnouncementKey(update('stale', { detail: 'a' }))).toBe(
      payoutAnnouncementKey(update('stale', { detail: 'b' })),
    );
  });

  it('maps lifecycle statuses to the five announcement states', () => {
    expect(mapPayoutLifecycleStatus('idle')).toBe('queued');
    expect(mapPayoutLifecycleStatus('initiated')).toBe('queued');
    expect(mapPayoutLifecycleStatus('pending')).toBe('processing');
    expect(mapPayoutLifecycleStatus('submitting')).toBe('processing');
    expect(mapPayoutLifecycleStatus('confirmed')).toBe('processing');
    expect(mapPayoutLifecycleStatus('success')).toBe('settled');
    expect(mapPayoutLifecycleStatus('failed')).toBe('failed');
    expect(mapPayoutLifecycleStatus('reversed')).toBe('failed');
    expect(mapPayoutLifecycleStatus('cancelled')).toBe('failed');
    expect(mapPayoutLifecycleStatus(null)).toBeNull();
  });

  it('treats stale read models as provisional but keeps terminal outcomes', () => {
    expect(mapPayoutLifecycleStatus('pending', true)).toBe('stale');
    expect(mapPayoutLifecycleStatus('confirmed', true)).toBe('stale');
    expect(mapPayoutLifecycleStatus('success', true)).toBe('settled');
    expect(mapPayoutLifecycleStatus('failed', true)).toBe('failed');
  });
});
