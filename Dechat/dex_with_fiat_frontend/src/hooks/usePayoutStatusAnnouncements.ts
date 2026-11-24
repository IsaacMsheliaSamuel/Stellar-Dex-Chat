'use client';

import { useEffect, useReducer } from 'react';
import {
  createPayoutAnnouncementState,
  reducePayoutAnnouncements,
  type PayoutAnnouncementEntry,
  type PayoutAnnouncementStatus,
} from '@/lib/payoutStatusAnnouncements';

export interface UsePayoutStatusAnnouncementsOptions {
  /** Stable transfer reference. A change clears the previous history. */
  reference?: string;
  status: PayoutAnnouncementStatus | null | undefined;
  detail?: string;
  at?: Date | string | number;
  /** Suppress announcements while the timeline is loading or unmounted. */
  enabled?: boolean;
}

export interface PayoutStatusAnnouncementResult {
  /** Text for the single live region. Empty when nothing new was announced. */
  announcement: string;
  /** Bounded, ordered log for at-the-pace review (never a live region). */
  history: PayoutAnnouncementEntry[];
  current: PayoutAnnouncementEntry | null;
}

/**
 * Converts async payout status updates into one deduplicated announcement and
 * a separate reviewable history. Dispatching through a reducer means repeated
 * renders and duplicate polls cannot re-announce the same transition.
 */
export function usePayoutStatusAnnouncements({
  reference = '',
  status,
  detail,
  at,
  enabled = true,
}: UsePayoutStatusAnnouncementsOptions): PayoutStatusAnnouncementResult {
  const [state, dispatch] = useReducer(
    reducePayoutAnnouncements,
    reference,
    createPayoutAnnouncementState,
  );

  useEffect(() => {
    if (!enabled || !status) return;
    dispatch({ reference, status, detail, at });
  }, [enabled, status, reference, detail, at]);

  return {
    announcement: state.current?.message ?? '',
    history: state.history,
    current: state.current,
  };
}
