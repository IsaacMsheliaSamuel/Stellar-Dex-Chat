'use client';

/** Name of the IndexedDB database for offline message queue. */
const DB_NAME = 'dechat-offline-queue';
/** Version of the IndexedDB database schema. */
const DB_VERSION = 1;
/** Name of the IndexedDB object store for queued messages. */
const STORE_NAME = 'queued-messages';

/**
 * Classification of a queued action for replay safety.
 *
 * `safe_to_retry` actions (e.g. chat messages) can be automatically resubmitted
 * when connectivity returns after basic revalidation. `never_auto_submit`
 * actions (e.g. financial intents like deposits, withdrawals, payouts) must
 * never be replayed without explicit user consent and full revalidation of
 * quotes, balances, account identity, and consent.
 */
export type QueuedActionType = 'safe_to_retry' | 'never_auto_submit';

/**
 * Represents a message queued for sending when the user is offline.
 *
 * This interface captures all the information needed to reconstruct and send
 * a message when connectivity is restored, including the message content,
 * user/assistant IDs, and the state machine snapshot for optimistic UI updates.
 *
 * @property id - Unique identifier for the queued message record.
 * @property content - The message content to be sent.
 * @property optimisticUserId - The user ID assigned optimistically before server confirmation.
 * @property pendingAssistantId - The assistant ID expected to respond to this message.
 * @property machineSnapshot - The state machine snapshot for optimistic UI state restoration.
 * @property queuedAt - Unix timestamp in milliseconds when the message was queued.
 * @property actionType - Classification of the queued action for replay safety.
 * @property requiresRevalidation - When true, the action must be revalidated
 *   (quotes, balances, identity, consent) before any resume attempt.
 * @property maxRetryAgeMs - Maximum age in milliseconds after which a queued
 *   action is considered stale and must not be automatically retried.
 */
export interface QueuedMessageRecord {
  id: string;
  content: string;
  optimisticUserId: string;
  pendingAssistantId: string;
  machineSnapshot: unknown;
  queuedAt: number;
  actionType: QueuedActionType;
  requiresRevalidation: boolean;
  maxRetryAgeMs: number;
}

/**
 * Checks if IndexedDB is available in the current environment.
 *
 * This function guards against server-side rendering (SSR) scenarios where
 * IndexedDB is not available. It's used internally by all public functions to
 * gracefully handle environments without IndexedDB support.
 *
 * @returns true if IndexedDB is available, false otherwise.
 *
 * @example
 * ```ts
 * if (isIndexedDbAvailable()) {
 *   // Safe to use IndexedDB operations
 * } else {
 *   // Fallback to in-memory queue or skip
 * }
 * ```
 */
function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Opens the IndexedDB database for the offline message queue.
 *
 * This function handles database initialization, including schema upgrades if
 * needed. The object store is created with 'id' as the key path for efficient
 * lookups.
 *
 * @returns A Promise that resolves to the IDBDatabase instance.
 * @throws Rejects with the IndexedDB error if the database cannot be opened.
 *
 * @example
 * ```ts
 * try {
 *   const db = await openDb();
 *   // Use database for operations
 * } catch (error) {
 *   console.error('Failed to open database:', error);
 * }
 * ```
 *
 * @see {@link isIndexedDbAvailable} - Check availability before calling
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Adds a message to the offline queue for later sending.
 *
 * This function stores a message record in IndexedDB when the user is offline
 * or experiencing connectivity issues. The message can be retrieved and sent
 * when connectivity is restored. If IndexedDB is not available (e.g., SSR),
 * the function silently does nothing.
 *
 * @param record - The queued message record to store, including content, IDs,
 *   and state snapshot.
 *
 * @returns A Promise that resolves when the message is successfully queued.
 * @throws Rejects with the IndexedDB transaction error if the operation fails.
 *
 * @example
 * ```ts
 * const record: QueuedMessageRecord = {
 *   id: 'msg-123',
 *   content: 'Hello, I have a question',
 *   optimisticUserId: 'user-456',
 *   pendingAssistantId: 'assistant-789',
 *   machineSnapshot: currentState,
 *   queuedAt: Date.now()
 * };
 *
 * await addQueuedMessage(record);
 * console.log('Message queued for offline sending');
 * ```
 *
 * @see {@link removeQueuedMessage} - Remove a message from the queue
 * @see {@link getAllQueuedMessages} - Retrieve all queued messages
 * @see {@link subscribeToQueuedMessageCount} - Monitor queue size
 */
export async function addQueuedMessage(
  record: QueuedMessageRecord,
): Promise<void> {
  if (!isIndexedDbAvailable()) {
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Removes a message from the offline queue.
 *
 * This function deletes a queued message record by its ID, typically called
 * after the message has been successfully sent or if the user cancels the
 * message. If IndexedDB is not available, the function silently does nothing.
 *
 * @param id - The unique identifier of the queued message to remove.
 *
 * @returns A Promise that resolves when the message is successfully removed.
 * @throws Rejects with the IndexedDB transaction error if the operation fails.
 *
 * @example
 * ```ts
 * // After successfully sending a queued message
 * await sendMessageToServer(message);
 * await removeQueuedMessage(message.id);
 * console.log('Message removed from queue');
 *
 * // When user cancels a pending message
 * onCancel(() => {
 *   removeQueuedMessage(messageId);
 * });
 * ```
 *
 * @see {@link addQueuedMessage} - Add a message to the queue
 * @see {@link getAllQueuedMessages} - Retrieve all queued messages
 */
export async function removeQueuedMessage(id: string): Promise<void> {
  if (!isIndexedDbAvailable()) {
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieves all messages currently in the offline queue.
 *
 * This function fetches all queued message records from IndexedDB, typically
 * called when connectivity is restored to batch-send pending messages. If
 * IndexedDB is not available, returns an empty array.
 *
 * @returns A Promise that resolves to an array of all queued message records.
 *   Returns an empty array if IndexedDB is unavailable or no messages are queued.
 * @throws Rejects with the IndexedDB transaction error if the operation fails.
 *
 * @example
 * ```ts
 * // When connectivity is restored
 * window.addEventListener('online', async () => {
 *   const messages = await getAllQueuedMessages();
 *   for (const message of messages) {
 *     try {
 *       await sendMessageToServer(message);
 *       await removeQueuedMessage(message.id);
 *     } catch (error) {
 *       console.error('Failed to send message:', error);
 *     }
 *   }
 * });
 * ```
 *
 * @see {@link addQueuedMessage} - Add a message to the queue
 * @see {@link removeQueuedMessage} - Remove a message from the queue
 * @see {@link getQueuedMessageCount} - Get the count of queued messages
 */
export async function getAllQueuedMessages(): Promise<QueuedMessageRecord[]> {
  if (!isIndexedDbAvailable()) {
    return [];
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as QueuedMessageRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** Type definition for a listener function that receives queued message count updates. */
type CountListener = (count: number) => void;
/** Set of all subscribed listeners for queued message count changes. */
const countListeners: Set<CountListener> = new Set();
/** Current count of queued messages, used for listener notifications. */
let currentCount = 0;

/**
 * Subscribes to changes in the queued message count.
 *
 * This function allows components to reactively monitor the number of messages
 * in the offline queue. The listener is immediately called with the current count
 * upon subscription, and will be called whenever the count changes via
 * {@link setQueuedMessageCount}.
 *
 * @param listener - A callback function that receives the current count of
 *   queued messages. Called immediately on subscription and on count changes.
 *
 * @returns An unsubscribe function that, when called, removes the listener from
 *   future count updates.
 *
 * @example
 * ```ts
 * // In a React component
 * useEffect(() => {
 *   const unsubscribe = subscribeToQueuedMessageCount((count) => {
 *     setQueuedCount(count);
 *     if (count > 0) {
 *       showOfflineIndicator();
 *     }
 *   });
 *
 *   return () => unsubscribe();
 * }, []);
 * ```
 *
 * @see {@link setQueuedMessageCount} - Update the count and notify listeners
 * @see {@link getQueuedMessageCount} - Get the current count
 */
export function subscribeToQueuedMessageCount(
  listener: CountListener,
): () => void {
  countListeners.add(listener);
  listener(currentCount);
  return () => countListeners.delete(listener);
}

/**
 * Updates the queued message count and notifies all subscribers.
 *
 * This function should be called whenever messages are added to or removed from
 * the queue to keep all subscribed listeners in sync. It updates the internal
 * count and immediately notifies all registered listeners.
 *
 * @param count - The new count of queued messages.
 *
 * @returns void
 *
 * @example
 * ```ts
 * // After adding a message to the queue
 * await addQueuedMessage(record);
 * setQueuedMessageCount(await getQueuedMessageCount() + 1);
 *
 * // After removing a message from the queue
 * await removeQueuedMessage(id);
 * setQueuedMessageCount(await getQueuedMessageCount() - 1);
 * ```
 *
 * @see {@link subscribeToQueuedMessageCount} - Subscribe to count changes
 * @see {@link getQueuedMessageCount} - Get the current count
 */
export function setQueuedMessageCount(count: number): void {
  currentCount = count;
  countListeners.forEach((listener) => listener(count));
}

/**
 * Gets the current count of queued messages.
 *
 * This function returns the internally tracked count of messages in the offline
 * queue. Note that this count is manually managed via {@link setQueuedMessageCount}
 * and may not reflect the actual IndexedDB contents if not properly synchronized.
 *
 * @returns The current count of queued messages.
 *
 * @example
 * ```ts
 * // Display the count in the UI
 * const count = getQueuedMessageCount();
 * if (count > 0) {
 *   return `${count} message(s) pending`;
 * }
 *
 * // Check if there are pending messages
 * if (getQueuedMessageCount() > 0) {
 *   showWarning('You have unsent messages');
 * }
 * ```
 *
 * @see {@link subscribeToQueuedMessageCount} - Subscribe to count changes
 * @see {@link setQueuedMessageCount} - Update the count
 * @see {@link getAllQueuedMessages} - Get all queued messages
 */
export function getQueuedMessageCount(): number {
  return currentCount;
}

/**
 * Maximum age (30 minutes) after which a queued financial action is considered
 * stale and must not be automatically retried without explicit user action.
 */
export const STALE_ACTION_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Classifies a queued message record into a replay-safe action type.
 *
 * Actions that carry financial intent (deposit, withdrawal, payout, transfer)
 * are classified as `never_auto_submit` and must never be replayed without
 * explicit user consent and full revalidation. Plain chat messages are
 * `safe_to_retry`.
 *
 * @param content - The queued message content to inspect for financial intent.
 * @returns `never_auto_submit` when the content references financial actions,
 *   otherwise `safe_to_retry`.
 */
export function classifyQueuedAction(content: string): QueuedActionType {
  const financialKeywords = [
    'deposit',
    'withdraw',
    'withdrawal',
    'payout',
    'transfer',
    'send',
    'convert',
    'swap',
    'bridge',
  ];
  const lower = content.toLowerCase();
  const hasFinancialIntent = financialKeywords.some((kw) => lower.includes(kw));
  return hasFinancialIntent ? 'never_auto_submit' : 'safe_to_retry';
}

/**
 * Determines whether a queued record is stale and must not be automatically
 * retried. A record is stale when its age exceeds `maxRetryAgeMs` or when it
 * is a `never_auto_submit` action that has aged beyond the global stale
 * threshold.
 *
 * @param record - The queued message record to evaluate.
 * @param now - Current Unix timestamp in milliseconds (defaults to Date.now()).
 * @returns true when the record is considered stale for automatic replay.
 */
export function isQueuedActionStale(
  record: QueuedMessageRecord,
  now: number = Date.now(),
): boolean {
  const age = now - record.queuedAt;
  const maxAge = record.maxRetryAgeMs ?? STALE_ACTION_MAX_AGE_MS;
  if (age > maxAge) return true;
  if (record.actionType === 'never_auto_submit' && age > STALE_ACTION_MAX_AGE_MS) {
    return true;
  }
  return false;
}

/**
 * Builds a `QueuedMessageRecord` with replay-safety defaults applied.
 *
 * Financial-intent content is automatically classified as `never_auto_submit`
 * with revalidation required. Chat-only content is `safe_to_retry`.
 *
 * @param fields - Partial record fields; `id`, `content`, `optimisticUserId`,
 *   `pendingAssistantId`, `machineSnapshot`, and `queuedAt` are required.
 * @returns A complete `QueuedMessageRecord` with replay-safety defaults.
 */
export function buildQueuedMessageRecord(fields: {
  id: string;
  content: string;
  optimisticUserId: string;
  pendingAssistantId: string;
  machineSnapshot: unknown;
  queuedAt?: number;
  actionType?: QueuedActionType;
  requiresRevalidation?: boolean;
  maxRetryAgeMs?: number;
}): QueuedMessageRecord {
  const inferredType = fields.actionType ?? classifyQueuedAction(fields.content);
  return {
    id: fields.id,
    content: fields.content,
    optimisticUserId: fields.optimisticUserId,
    pendingAssistantId: fields.pendingAssistantId,
    machineSnapshot: fields.machineSnapshot,
    queuedAt: fields.queuedAt ?? Date.now(),
    actionType: inferredType,
    requiresRevalidation:
      fields.requiresRevalidation ?? inferredType === 'never_auto_submit',
    maxRetryAgeMs: fields.maxRetryAgeMs ?? STALE_ACTION_MAX_AGE_MS,
  };
}
