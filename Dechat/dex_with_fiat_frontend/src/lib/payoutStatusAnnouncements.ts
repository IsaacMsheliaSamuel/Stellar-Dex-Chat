/**
 * Accessible announcements for asynchronous payout transitions (Issue #291).
 *
 * The payout lifecycle is reported by more than one source (on-chain stage,
 * provider polling, push webhooks and read-model freshness). Screen readers
 * must hear each *distinct* transition once, in plain language, while the
 * full ordered history stays available for users who want to review it at
 * their own pace.
 *
 * This module is intentionally free of React so the message contract,
 * de-duplication and monotonic rules can be regression tested in isolation.
 */

import { sanitizeDiagnostics } from './transactionErrorRecovery';

/** The five states exposed to assistive technology. */
export type PayoutAnnouncementStatus =
  | 'queued'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'stale';

/** Lifecycle statuses produced by the transfer status reconciler. */
export type PayoutLifecycleStatus =
  | 'idle'
  | 'initiated'
  | 'pending'
  | 'submitting'
  | 'confirmed'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export interface PayoutAnnouncementInput {
  /** Stable transfer reference; a change starts a new announcement history. */
  reference: string;
  status: PayoutAnnouncementStatus;
  /** Optional, non-sensitive detail appended to `failed` announcements. */
  detail?: string;
  /** When the transition was observed. Defaults to the current time. */
  at?: Date | string | number;
}

export interface PayoutAnnouncementEntry {
  /** Identity used to suppress repeated announcements. */
  key: string;
  reference: string;
  status: PayoutAnnouncementStatus;
  message: string;
  /** ISO-8601 timestamp, for the reviewable history. */
  at: string;
}

export interface PayoutAnnouncementState {
  reference: string;
  current: PayoutAnnouncementEntry | null;
  /** Oldest first. Bounded so a long-running polling session cannot grow forever. */
  history: PayoutAnnouncementEntry[];
}

/**
 * Concise, sentence-length messages. They deliberately contain no amounts,
 * account numbers, hashes or provider error text.
 */
export const PAYOUT_ANNOUNCEMENT_MESSAGES: Readonly<
  Record<PayoutAnnouncementStatus, string>
> = {
  queued: 'Payout queued.',
  processing: 'Payout processing.',
  settled: 'Payout settled.',
  failed: 'Payout failed.',
  stale: 'Payout status is out of date. Refresh before acting.',
};

/** A settled or failed payout is final; later non-terminal polls must not downgrade it. */
const TERMINAL_STATUSES: ReadonlySet<PayoutAnnouncementStatus> = new Set([
  'settled',
  'failed',
]);

/**
 * `stale` describes data freshness, not a new lifecycle stage. It sits at the
 * same rank as `processing` so recovery can move forward from it, but it can
 * never move a payout backwards to `queued`.
 */
const STATUS_RANK: Readonly<Record<PayoutAnnouncementStatus, number>> = {
  queued: 0,
  processing: 1,
  stale: 1,
  settled: 2,
  failed: 2,
};

export const MAX_PAYOUT_ANNOUNCEMENT_HISTORY = 20;

const MAX_DETAIL_LENGTH = 80;

export function createPayoutAnnouncementState(
  reference = '',
): PayoutAnnouncementState {
  return { reference, current: null, history: [] };
}

function normalizeTimestamp(at?: Date | string | number): string {
  if (at instanceof Date) {
    return Number.isNaN(at.getTime())
      ? new Date().toISOString()
      : at.toISOString();
  }
  if (typeof at === 'number') {
    return Number.isFinite(at)
      ? new Date(at).toISOString()
      : new Date().toISOString();
  }
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed)
      ? new Date().toISOString()
      : new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Removes secrets, long numeric identifiers (bank accounts / references) and
 * control characters before any provider detail reaches the live region.
 */
function sanitizeDetail(detail: string | undefined): string {
  if (!detail) return '';
  return sanitizeDiagnostics(detail)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b\d{8,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH)
    .replace(/[.\s]+$/, '');
}

/** Build the exact string placed in the live region. */
export function buildPayoutAnnouncement(
  input: Pick<PayoutAnnouncementInput, 'status' | 'detail'>,
): string {
  const base = PAYOUT_ANNOUNCEMENT_MESSAGES[input.status];
  const detail = sanitizeDetail(input.detail);
  if (!detail || input.status !== 'failed') return base;
  return `${base} ${detail}.`;
}

/**
 * Identity of an announcement. Re-polling the same state must not produce a
 * second announcement, even when the underlying record timestamp changes.
 */
export function payoutAnnouncementKey(input: PayoutAnnouncementInput): string {
  return [
    input.reference,
    input.status,
    sanitizeDetail(input.status === 'failed' ? input.detail : undefined),
  ].join('|');
}

/**
 * Monotonic, de-duplicating reducer. Returns the *same* state object when an
 * update must not be announced, which makes it safe to call on every render.
 */
export function reducePayoutAnnouncements(
  state: PayoutAnnouncementState,
  input: PayoutAnnouncementInput,
): PayoutAnnouncementState {
  const reference = input.reference ?? '';
  const base =
    state.reference === reference
      ? state
      : createPayoutAnnouncementState(reference);
  const current = base.current;
  const key = payoutAnnouncementKey({ ...input, reference });

  // Repeated poll / re-render with the same transition: announce once.
  if (current?.key === key) return base;

  // Terminal transitions are final. Delayed or out-of-order updates must not
  // replace them in the live region (financial safety: no settlement downgrade).
  if (current && TERMINAL_STATUSES.has(current.status)) return base;

  if (current) {
    const incomingRank = STATUS_RANK[input.status];
    const currentRank = STATUS_RANK[current.status];
    // A recovery from stale may resume processing, but never restart at queued.
    if (incomingRank < currentRank) return base;
  }

  const entry: PayoutAnnouncementEntry = {
    key,
    reference,
    status: input.status,
    message: buildPayoutAnnouncement(input),
    at: normalizeTimestamp(input.at),
  };

  return {
    reference,
    current: entry,
    history: [...base.history, entry].slice(-MAX_PAYOUT_ANNOUNCEMENT_HISTORY),
  };
}

/** Maps a reconciler lifecycle status to the five announcement states. */
export function mapPayoutLifecycleStatus(
  status: PayoutLifecycleStatus | null | undefined,
  isStale = false,
): PayoutAnnouncementStatus | null {
  if (!status) return null;

  const terminal =
    status === 'success' ||
    status === 'failed' ||
    status === 'reversed' ||
    status === 'cancelled';

  // Stale read-model data must never be presented as confirmed settlement.
  if (isStale && !terminal) return 'stale';

  switch (status) {
    case 'idle':
    case 'initiated':
      return 'queued';
    case 'pending':
    case 'submitting':
    case 'confirmed':
      return 'processing';
    case 'success':
      return 'settled';
    case 'failed':
    case 'reversed':
    case 'cancelled':
      return 'failed';
    default:
      return null;
  }
}
