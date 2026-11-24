/**
 * Schema version for the chat draft format. Increment when the draft
 * structure changes; older drafts are migrated or discarded on read.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/**
 * Schema version for the user preferences format. Increment when the
 * preferences structure changes; older preferences are migrated or reset.
 */
export const PREFERENCES_SCHEMA_VERSION = 1;

const PREFERENCES_KEY = 'user_preferences_v1';

/**
 * Represents a message draft stored in localStorage.
 *
 * @property content - The draft message content.
 * @property timestamp - Unix timestamp in milliseconds when the draft was saved.
 * @property version - Schema version of the draft format, used for migration.
 * @property sessionId - The session ID this draft belongs to.
 */
export interface Draft {
  content: string;
  timestamp: number;
  version: number;
  sessionId?: string;
}

const DRAFT_PREFIX = 'chat_draft_';
/** Default time-to-live for drafts in seconds (24 hours). */
const DEFAULT_TTL = 86400; // 24 hours in seconds

/**
 * Maximum draft content size in bytes before the draft is considered oversized
 * and rejected to prevent localStorage quota exhaustion.
 */
const MAX_DRAFT_SIZE_BYTES = 10_000; // 10 KB

/**
 * Migration result for a stored draft.
 */
export type DraftMigrationResult =
  | { kind: 'valid'; draft: Draft }
  | { kind: 'migrated'; draft: Draft }
  | { kind: 'discarded'; reason: 'corrupt' | 'oversized' | 'unknown_version' };

/**
 * Saves a message draft for a specific session to localStorage.
 *
 * This function persists a draft message for a given session ID, allowing users
 * to recover unsaved messages after page refreshes or navigation. If the content
 * is empty or whitespace-only, the draft is cleared instead of saved.
 *
 * @param sessionId - Unique identifier for the chat session. Used as part of the
 *   localStorage key to isolate drafts between different conversations.
 * @param content - The draft message content to save. Empty or whitespace-only
 *   content will result in clearing the draft instead.
 *
 * @returns void
 *
 * @throws Will log an error to console if localStorage is unavailable or quota
 *   is exceeded, but will not throw an exception to avoid disrupting the UI.
 *
 * @example
 * ```ts
 * // Save a draft for session 'user-123-chat-456'
 * saveDraft('user-123-chat-456', 'Hello, I have a question about...');
 *
 * // Clear draft by saving empty content
 * saveDraft('user-123-chat-456', '');
 * ```
 *
 * @see {@link getDraft} - Retrieve a saved draft
 * @see {@link clearDraft} - Explicitly clear a draft
 * @see {@link clearExpiredDrafts} - Clean up old drafts
 */
export const saveDraft = (sessionId: string, content: string): void => {
  if (typeof window === 'undefined' || !sessionId) return;

  if (!content.trim()) {
    clearDraft(sessionId);
    return;
  }

  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength > MAX_DRAFT_SIZE_BYTES) {
    console.error(
      'Draft exceeds maximum size and will not be saved',
      { sessionId, sizeBytes: encoded.byteLength },
    );
    return;
  }

  const draft: Draft = {
    content,
    timestamp: Date.now(),
    version: DRAFT_SCHEMA_VERSION,
    sessionId,
  };
  try {
    localStorage.setItem(`${DRAFT_PREFIX}${sessionId}`, JSON.stringify(draft));
  } catch (e) {
    console.error('Failed to save draft to localStorage', e);
  }
};

/**
 * Retrieves a message draft for a specific session, checking for expiry.
 *
 * This function fetches a draft from localStorage and validates that it has not
 * exceeded its time-to-live (TTL). Expired drafts are automatically cleared and
 * return null. This ensures users don't see stale drafts from old sessions.
 *
 * @param sessionId - Unique identifier for the chat session to retrieve the draft for.
 * @param ttlSeconds - Optional time-to-live in seconds. Defaults to 24 hours
 *   (86400 seconds). Drafts older than this are considered expired.
 *
 * @returns The draft content as a string if found and not expired, or null if
 *   no draft exists, it has expired, or an error occurred.
 *
 * @throws Will log an error to console if JSON parsing fails, but will not throw
 *   an exception to avoid disrupting the UI.
 *
 * @example
 * ```ts
 * // Get draft with default 24-hour TTL
 * const draft = getDraft('user-123-chat-456');
 * if (draft) {
 *   console.log('Recovered draft:', draft);
 * }
 *
 * // Get draft with custom 1-hour TTL
 * const recentDraft = getDraft('user-123-chat-456', 3600);
 * ```
 *
 * @see {@link saveDraft} - Save a draft
 * @see {@link clearDraft} - Explicitly clear a draft
 * @see {@link clearExpiredDrafts} - Clean up old drafts
 */
export const getDraft = (
  sessionId: string,
  ttlSeconds: number = DEFAULT_TTL,
): string | null => {
  if (typeof window === 'undefined' || !sessionId) return null;

  const item = localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`);
  if (!item) return null;

  const migration = migrateDraft(item);
  if (migration.kind !== 'valid' && migration.kind !== 'migrated') {
    clearDraft(sessionId);
    return null;
  }

  const draft = migration.draft;
  const now = Date.now();
  const expiryTime = draft.timestamp + ttlSeconds * 1000;

  if (now > expiryTime) {
    clearDraft(sessionId);
    return null;
  }

  // Persist migrated draft back to storage so future reads skip migration
  if (migration.kind === 'migrated') {
    try {
      localStorage.setItem(
        `${DRAFT_PREFIX}${sessionId}`,
        JSON.stringify(draft),
      );
    } catch {
      // Ignore persistence failures; the migrated draft is still returned.
    }
  }

  return draft.content;
};

/**
 * Clears a specific message draft from localStorage.
 *
 * This function removes the draft associated with a given session ID. This is
 * typically called after a message is successfully sent, when the user explicitly
 * discards a draft, or when saving empty content via {@link saveDraft}.
 *
 * @param sessionId - Unique identifier for the chat session whose draft should
 *   be cleared.
 *
 * @returns void
 *
 * @throws Will log an error to console if localStorage is unavailable, but will
 *   not throw an exception to avoid disrupting the UI.
 *
 * @example
 * ```ts
 * // Clear draft after sending message
 * sendMessage(message);
 * clearDraft('user-123-chat-456');
 *
 * // Clear draft when user discards it
 * onDiscardClick(() => {
 *   clearDraft('user-123-chat-456');
 * });
 * ```
 *
 * @see {@link saveDraft} - Save a draft
 * @see {@link getDraft} - Retrieve a saved draft
 * @see {@link clearExpiredDrafts} - Clean up old drafts
 */
export const clearDraft = (sessionId: string): void => {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    localStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`);
  } catch (e) {
    console.error('Failed to clear draft from localStorage', e);
  }
}

/**
 * Clears all drafts that have expired based on their timestamp.
 *
 * This function iterates through all draft entries in localStorage and removes
 * those that have exceeded the specified time-to-live (TTL). It's useful for
 * cleanup operations to prevent localStorage bloat from accumulating old drafts.
 * Malformed draft entries are also removed to prevent parsing errors.
 *
 * @param ttlSeconds - Optional time-to-live in seconds. Defaults to 24 hours
 *   (86400 seconds). Drafts older than this are considered expired.
 *
 * @returns void
 *
 * @throws Will log an error to console if localStorage iteration fails, but will
 *   not throw an exception to avoid disrupting the UI.
 *
 * @example
 * ```ts
 * // Clean up expired drafts on app initialization
 * useEffect(() => {
 *   clearExpiredDrafts();
 * }, []);
 *
 * // Clean up drafts older than 1 hour
 * clearExpiredDrafts(3600);
 * ```
 *
 * @see {@link saveDraft} - Save a draft
 * @see {@link getDraft} - Retrieve a saved draft (also clears expired drafts)
 * @see {@link clearDraft} - Clear a specific draft
 */
export const clearExpiredDrafts = (ttlSeconds: number = DEFAULT_TTL): void => {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(DRAFT_PREFIX)) {
      try {
        const item = localStorage.getItem(key);
        if (item) {
          const migration = migrateDraft(item);
          if (migration.kind !== 'valid' && migration.kind !== 'migrated') {
            keysToRemove.push(key);
            continue;
          }
          const draft = migration.draft;
          const expiryTime = draft.timestamp + ttlSeconds * 1000;
          if (now > expiryTime) {
            keysToRemove.push(key);
          }
        }
      } catch {
        keysToRemove.push(key!);
      }
    }
  }

  keysToRemove.forEach((key) => localStorage.removeItem(key));
};

/**
 * Migrates a raw stored draft string to the current schema version.
 *
 * Handles corrupt JSON, unknown schema versions, and oversized payloads by
 * returning a discard result. Drafts from older schema versions (version 0,
 * i.e. pre-versioned drafts with no `version` field) are migrated by adding
 * the current version and session ID.
 *
 * @param item - The raw JSON string from localStorage.
 * @returns A migration result indicating whether the draft is valid, migrated,
 *   or discarded.
 */
export function migrateDraft(item: string): DraftMigrationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(item);
  } catch {
    return { kind: 'discarded', reason: 'corrupt' };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return { kind: 'discarded', reason: 'corrupt' };
  }

  const record = parsed as Record<string, unknown>;
  const version = record.version;

  // Pre-versioned drafts (no version field) are treated as version 0
  const draftVersion = typeof version === 'number' ? version : 0;

  if (draftVersion > DRAFT_SCHEMA_VERSION) {
    return { kind: 'discarded', reason: 'unknown_version' };
  }

  const content = typeof record.content === 'string' ? record.content : '';
  const timestamp =
    typeof record.timestamp === 'number' ? record.timestamp : Date.now();

  if (content.length === 0) {
    return { kind: 'discarded', reason: 'corrupt' };
  }

  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength > MAX_DRAFT_SIZE_BYTES) {
    return { kind: 'discarded', reason: 'oversized' };
  }

  const migratedDraft: Draft = {
    content,
    timestamp,
    version: DRAFT_SCHEMA_VERSION,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
  };

  if (draftVersion === DRAFT_SCHEMA_VERSION) {
    return { kind: 'valid', draft: migratedDraft };
  }

  return { kind: 'migrated', draft: migratedDraft };
}

/**
 * Persisted user preferences with schema versioning for migration.
 */
export interface PersistedPreferences {
  version: number;
  fiatCurrency: string;
  remindersEnabled: boolean;
  reminderFrequency: 'weekly' | 'monthly';
  maskingEnabled: boolean;
  maskingStyle: string;
  highValueThreshold: number;
  twoFactorEnabled: boolean;
  timestamp: number;
}

/**
 * Saves the full user preferences object to localStorage with schema versioning.
 *
 * @param preferences - The preferences to persist.
 * @returns true when successfully saved, false on storage failure.
 */
export function savePreferences(preferences: PersistedPreferences): boolean {
  if (typeof window === 'undefined') return false;

  const toStore: PersistedPreferences = {
    ...preferences,
    version: PREFERENCES_SCHEMA_VERSION,
    timestamp: Date.now(),
  };

  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(toStore));
    return true;
  } catch (e) {
    console.error('Failed to save preferences to localStorage', e);
    return false;
  }
}

/**
 * Retrieves and migrates user preferences from localStorage.
 *
 * Handles corrupt JSON, unknown schema versions, and missing fields by
 * returning null so the caller can apply defaults.
 *
 * @returns The migrated preferences, or null if none exist or migration failed.
 */
export function getPreferences(): PersistedPreferences | null {
  if (typeof window === 'undefined') return null;

  const item = localStorage.getItem(PREFERENCES_KEY);
  if (!item) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(item);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const version = typeof record.version === 'number' ? record.version : 0;

  if (version > PREFERENCES_SCHEMA_VERSION) {
    return null;
  }

  // Migrate from older versions by applying defaults for missing fields
  const migrated: PersistedPreferences = {
    version: PREFERENCES_SCHEMA_VERSION,
    fiatCurrency: typeof record.fiatCurrency === 'string' ? record.fiatCurrency : 'usd',
    remindersEnabled: typeof record.remindersEnabled === 'boolean' ? record.remindersEnabled : false,
    reminderFrequency:
      typeof record.reminderFrequency === 'string' &&
      (record.reminderFrequency === 'weekly' ||
        record.reminderFrequency === 'monthly')
        ? record.reminderFrequency
        : 'weekly',
    maskingEnabled: typeof record.maskingEnabled === 'boolean' ? record.maskingEnabled : false,
    maskingStyle:
      typeof record.maskingStyle === 'string' ? record.maskingStyle : 'asterisk',
    highValueThreshold:
      typeof record.highValueThreshold === 'number' ? record.highValueThreshold : 500,
    twoFactorEnabled:
      typeof record.twoFactorEnabled === 'boolean' ? record.twoFactorEnabled : true,
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.now(),
  };

  // Persist migrated preferences back
  if (version !== PREFERENCES_SCHEMA_VERSION) {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(migrated));
    } catch {
      // Ignore persistence failures
    }
  }

  return migrated;
}

/**
 * Clears all persisted preferences from localStorage.
 */
export function clearPreferences(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(PREFERENCES_KEY);
  } catch {
    // Ignore storage failures
  }
}

/**
 * Transaction Draft Interface (Issue #70)
 * Scoped by wallet and network with strict privacy controls.
 * Sensitive fields (bank account numbers, secret keys, signed XDR payloads) are excluded.
 */
export const TRANSACTION_DRAFT_SCHEMA_VERSION = 1;
const TX_DRAFT_PREFIX = 'tx_draft_';

export interface TransactionDraft {
  version: number;
  walletAddress: string;
  network: string;
  asset: string;
  amount: string;
  destination: string;
  memo?: string;
  timestamp: number;
}

export const getTransactionDraftKey = (walletAddress: string, network: string): string => {
  return `${TX_DRAFT_PREFIX}${network.toLowerCase()}_${walletAddress.toLowerCase()}`;
};

/**
 * Persists a transaction draft with privacy sanitization.
 */
export const saveTransactionDraft = (
  walletAddress: string,
  network: string,
  draft: Omit<TransactionDraft, 'version' | 'walletAddress' | 'network' | 'timestamp'>
): boolean => {
  if (typeof window === 'undefined' || !walletAddress || !network) return false;

  // Sanitize: never store signed XDR or sensitive secrets
  const sanitizedDraft: TransactionDraft = {
    version: TRANSACTION_DRAFT_SCHEMA_VERSION,
    walletAddress,
    network,
    asset: draft.asset || 'XLM',
    amount: draft.amount || '',
    destination: draft.destination || '',
    memo: draft.memo ? draft.memo.slice(0, 28) : undefined, // Stellar text memo max length
    timestamp: Date.now(),
  };

  try {
    const key = getTransactionDraftKey(walletAddress, network);
    localStorage.setItem(key, JSON.stringify(sanitizedDraft));
    return true;
  } catch (error) {
    console.warn('Storage quota exceeded or storage unavailable for transaction draft', error);
    return false;
  }
};

/**
 * Retrieves and migrates/validates a transaction draft.
 */
export const getTransactionDraft = (
  walletAddress: string,
  network: string,
  ttlSeconds: number = DEFAULT_TTL
): TransactionDraft | null => {
  if (typeof window === 'undefined' || !walletAddress || !network) return null;

  const key = getTransactionDraftKey(walletAddress, network);
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;

    const parsed = JSON.parse(item);

    // Schema version check and migration handling
    if (!parsed || typeof parsed !== 'object' || parsed.version !== TRANSACTION_DRAFT_SCHEMA_VERSION) {
      console.warn('Corrupt or outdated draft schema encountered. Resetting draft.');
      localStorage.removeItem(key);
      return null;
    }

    // Expiry check
    if (Date.now() - parsed.timestamp > ttlSeconds * 1000) {
      localStorage.removeItem(key);
      return null;
    }

    return parsed as TransactionDraft;
  } catch (e) {
    console.warn('Corrupt storage payload for transaction draft. Purging.', e);
    localStorage.removeItem(key);
    return null;
  }
};

/**
 * Clear and reset transaction draft.
 */
export const clearTransactionDraft = (walletAddress: string, network: string): void => {
  if (typeof window === 'undefined' || !walletAddress || !network) return;
  const key = getTransactionDraftKey(walletAddress, network);
  localStorage.removeItem(key);
};
