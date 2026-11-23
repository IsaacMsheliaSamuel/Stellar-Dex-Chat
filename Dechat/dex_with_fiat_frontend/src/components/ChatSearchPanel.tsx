'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Calendar, Wallet, ChevronRight, User, Trash2 } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { ChatSession } from '@/types';
import {
  SearchFilters,
  MessageMatch,
  searchChatHistory,
  splitByHighlights,
  debounce,
  redactPayoutSensitiveFields,
  containsPayoutSensitiveData,
} from '@/lib/chatSearch';

interface ChatSearchPanelProps {
  sessions: ChatSession[];
  onSelectResult: (sessionId: string, messageId: string) => void;
  onClose: () => void;
  /** Connected wallet address used to scope search results to the current account. */
  connectedWalletAddress?: string;
}

/** Renders a single message snippet with keyword highlights. */
function HighlightedSnippet({
  match,
  isDarkMode,
}: {
  match: MessageMatch;
  isDarkMode: boolean;
}) {
  const content = match.message.content;
  // Show a short excerpt centred around the first highlight
  const firstHl = match.highlights[0];
  let snippetStart = 0;
  let snippetEnd = Math.min(content.length, 120);
  if (firstHl) {
    snippetStart = Math.max(0, firstHl[0] - 30);
    snippetEnd = Math.min(content.length, firstHl[1] + 90);
  }
  const snippet = content.slice(snippetStart, snippetEnd);
  const prefix = snippetStart > 0 ? '…' : '';
  const suffix = snippetEnd < content.length ? '…' : '';

  // Re-map highlight positions relative to snippet
  const relativeHighlights = match.highlights
    .map(([s, e]): [number, number] => [s - snippetStart, e - snippetStart])
    .filter(([s, e]) => s >= 0 && e <= snippet.length);

  const segments = splitByHighlights(snippet, relativeHighlights);

  return (
    <p className={`text-xs mt-1 leading-relaxed ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
      {prefix}
      {segments.map((seg, i) =>
        seg.highlight ? (
          <mark
            key={i}
            className={`rounded px-0.5 ${isDarkMode ? 'bg-yellow-500/30 text-yellow-200' : 'bg-yellow-200 text-yellow-900'}`}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
      {suffix}
    </p>
  );
}

const EMPTY_FILTERS: SearchFilters = {
  keyword: '',
  walletAddress: '',
  dateFrom: '',
  dateTo: '',
  accountScopedWallet: '',
};

export default function ChatSearchPanel({
  sessions,
  onSelectResult,
  onClose,
  connectedWalletAddress,
}: ChatSearchPanelProps) {
  const { isDarkMode } = useTheme();
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [results, setResults] = useState<MessageMatch[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // #1183: keep the active-result index in range whenever the result set
  // changes (e.g. a new keystroke narrows/reorders matches).
  useEffect(() => {
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [results]);

  // Reset all search state whenever the panel is closed so stale results
  // are never shown the next time the panel is opened (#947).
  const handleClose = () => {
    setFilters(EMPTY_FILTERS);
    setResults([]);
    setShowAdvanced(false);
    setShowDeleteDialog(false);
    onClose();
  };

  // Debounced search — runs 300 ms after the last filter change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runSearch = useCallback(
    debounce((f: unknown) => {
      const { matches } = searchChatHistory(sessions, f as SearchFilters);
      setResults(matches);
    }, 300),
    [sessions],
  );

  useEffect(() => {
    runSearch(filters);
  }, [filters, runSearch]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // #1183: ArrowDown/ArrowUp move the active result, Enter selects it,
  // Escape still closes the panel.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (results.length === 0) {
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const match = results[activeIndex];
      if (match) onSelectResult(match.sessionId, match.message.id);
    }
  };

  const hasAnyFilter =
    filters.keyword || filters.walletAddress || filters.dateFrom || filters.dateTo || filters.accountScopedWallet;

  const redactedCount = results.filter((r) => r.redacted).length;

  // Delete cached search results and any payout-sensitive localStorage records
  const handleDeleteCachedRecords = () => {
    // Clear any payout-sensitive cached data from localStorage
    const keysToRemove: string[] = [];
    if (typeof window !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('tx_draft_') || key.startsWith('stellar_pending_tx'))) {
          keysToRemove.push(key);
        }
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
    setResults([]);
    setFilters(EMPTY_FILTERS);
    setShowDeleteDialog(false);
  };

  return (
    <div
      className={`flex flex-col h-full ${isDarkMode ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'}`}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 px-4 py-3 border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <Search className={`w-4 h-4 flex-shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search messages…"
          value={filters.keyword}
          onChange={(e) => setFilters((f) => ({ ...f, keyword: e.target.value }))}
          className={`flex-1 bg-transparent text-sm outline-none placeholder:${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}
          aria-label="Search keyword"
        />
        {hasAnyFilter && (
          <button
            onClick={() =>
              setFilters({ keyword: '', walletAddress: '', dateFrom: '', dateTo: '' })
            }
            className={`p-1 rounded transition-colors ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
            title="Clear filters"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={handleClose}
          className={`p-1 rounded transition-colors ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          title="Close search"
          aria-label="Close search"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Advanced filters toggle */}
      <div className={`px-4 py-2 border-b ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className={`flex items-center gap-1 text-xs font-medium transition-colors ${isDarkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
        >
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
          />
          Advanced filters
        </button>

        {showAdvanced && (
          <div className="mt-3 grid grid-cols-1 gap-3">
            {/* Wallet address */}
            <label className="flex flex-col gap-1">
              <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                <Wallet className="inline w-3 h-3 mr-1" />
                Wallet address
              </span>
              <input
                type="text"
                placeholder="e.g. GABCD…"
                value={filters.walletAddress}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, walletAddress: e.target.value }))
                }
                className={`text-xs px-2 py-1.5 rounded border outline-none focus:ring-1 focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-700 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'}`}
                aria-label="Filter by wallet address"
              />
            </label>

            {/* Account-scoped wallet (privacy boundary) */}
            <label className="flex flex-col gap-1">
              <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                <User className="inline w-3 h-3 mr-1" />
                Account-scoped wallet
              </span>
              <input
                type="text"
                placeholder="e.g. GABCD…"
                value={filters.accountScopedWallet}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, accountScopedWallet: e.target.value }))
                }
                className={`text-xs px-2 py-1.5 rounded border outline-none focus:ring-1 focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-700 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'}`}
                aria-label="Scope search to account wallet"
              />
              <p className={`text-[10px] ${isDarkMode ? 'text-amber-400/70' : 'text-amber-600'}`}>
                Limits results to sessions owned by this wallet only.
              </p>
            </label>

            {/* Date range */}
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 flex-1">
                <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  <Calendar className="inline w-3 h-3 mr-1" />
                  From
                </span>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, dateFrom: e.target.value }))
                  }
                  className={`text-xs px-2 py-1.5 rounded border outline-none focus:ring-1 focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-700 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'}`}
                  aria-label="Date from"
                />
              </label>
              <label className="flex flex-col gap-1 flex-1">
                <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  To
                </span>
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, dateTo: e.target.value }))
                  }
                  className={`text-xs px-2 py-1.5 rounded border outline-none focus:ring-1 focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-700 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'}`}
                  aria-label="Date to"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!hasAnyFilter ? (
          <div className={`flex flex-col items-center justify-center h-full gap-2 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            <Search className="w-8 h-8 opacity-40" />
            <p className="text-sm">Type to search messages</p>
          </div>
        ) : results.length === 0 ? (
          <div className={`flex flex-col items-center justify-center h-full gap-2 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            <p className="text-sm">No messages found</p>
          </div>
        ) : (
          <ul className="divide-y" role="listbox" aria-label="Search results">
            {results.map((match, index) => (
              <li key={`${match.sessionId}-${match.message.id}`} role="option" aria-selected={index === activeIndex}>
                <button
                  onClick={() => onSelectResult(match.sessionId, match.message.id)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    index === activeIndex
                      ? isDarkMode
                        ? 'bg-gray-800'
                        : 'bg-gray-50'
                      : isDarkMode
                        ? 'hover:bg-gray-800'
                        : 'hover:bg-gray-50'
                  }`}
                >
                  <p className={`text-xs font-semibold truncate ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                    {match.sessionTitle}
                  </p>
                  <p className={`text-[11px] mt-0.5 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                    {match.message.role === 'user' ? 'You' : 'Assistant'} ·{' '}
                    {new Date(match.message.timestamp).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                  <HighlightedSnippet match={match} isDarkMode={isDarkMode} />
                  {match.redacted && (
                    <span className="text-[9px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20 ml-1">
                      Redacted
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer count */}
      {hasAnyFilter && (
        <div className={`px-4 py-2 border-t text-xs ${isDarkMode ? 'border-gray-800 text-gray-500' : 'border-gray-100 text-gray-400'}`}>
          {results.length} result{results.length !== 1 ? 's' : ''}
          {redactedCount > 0 && (
            <span className="ml-2 text-amber-500">
              ({redactedCount} redacted for privacy)
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowDeleteDialog(true)}
            className="ml-auto text-[10px] text-red-400 hover:text-red-300 underline"
            data-testid="delete-cached-records-button"
          >
            Delete cached records
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-semibold text-lg mb-4">
              Delete Cached Records
            </h3>
            <p className="text-gray-300 text-sm mb-6">
              This will remove all cached transaction drafts and pending
              transaction records from localStorage. Search results will be
              cleared. Payout-sensitive data in messages is already redacted.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteDialog(false)}
                className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteCachedRecords}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                Delete All Cached Records
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
