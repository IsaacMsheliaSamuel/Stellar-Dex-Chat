import React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StellarFiatModal from '../StellarFiatModal';

const { TEST_ADDRESS } = vi.hoisted(() => ({
  TEST_ADDRESS: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}));

const mockSignTx = vi.fn();
const mockDepositToContract = vi.fn();
const mockVerifyIdentity = vi.fn();
const mockRefreshXlmBalance = vi.fn().mockResolvedValue(undefined);
const mockRefetchStats = vi.fn().mockResolvedValue(undefined);

let sessionExpired = false;

vi.mock('@/contexts/StellarWalletContext', () => ({
  useStellarWallet: () => ({
    connection: {
      isConnected: true,
      publicKey: TEST_ADDRESS,
      address: TEST_ADDRESS,
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    signTx: (...args: unknown[]) => mockSignTx(...args),
    xlmBalance: '1000',
    refreshXlmBalance: mockRefreshXlmBalance,
    sessionExpired,
    reconnect: vi.fn(),
  }),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({
    fiatCurrency: 'usd',
    currencySymbol: '$',
    highValueThreshold: 10,
    twoFactorEnabled: true,
  }),
}));

vi.mock('@/lib/stellarContract', () => ({
  BRIDGE_LIMIT_WARNING_PERCENT: 80,
  CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  depositToContract: (...args: unknown[]) => mockDepositToContract(...args),
  withdrawFromContract: vi.fn(),
  verifyNetworkAndContractIdentity: (...args: unknown[]) => mockVerifyIdentity(...args),
  checkTransactionStatus: vi.fn(),
  pollTransaction: vi.fn(),
  clearCache: vi.fn(),
  simulateDeposit: vi.fn(),
  simulateWithdraw: vi.fn(),
  simulateTransactionPayload: vi.fn().mockResolvedValue({
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    operation: 'deposit',
    token: 'XLM',
    amountStroops: 1_000_000_000n,
    amountFormatted: '100',
    feeEstimate: { baseFee: 0.00001, resourceFee: 0.00005, fee: 0.00006, minFee: '600' },
    network: 'TESTNET',
    account: TEST_ADDRESS,
    expectedEffects: ['Transfer 100 XLM from bridge to escrow'],
    simulationTimestamp: Date.now(),
  }),
  getStellarDeploymentConfig: vi.fn().mockReturnValue({
    network: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'http://127.0.0.1:8000/soroban/rpc',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }),
}));

vi.mock('@/hooks/useBridgeStats', () => ({
  default: () => ({
    limit: 10_000_000_000_000n,
    loading: false,
    error: null,
    refetchStats: mockRefetchStats,
  }),
}));

vi.mock('@/lib/cryptoPriceService', () => ({
  getTokenPriceWithStatus: vi.fn().mockResolvedValue({ price: 0.12, stale: false, source: 'live' }),
  formatFiatAmount: vi.fn().mockReturnValue('$12.00'),
}));

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({ addNotification: vi.fn() }),
}));

vi.mock('@/hooks/useTxHistory', () => ({
  useTxHistory: () => ({
    addEntry: vi.fn(),
    entries: [],
    clearEntries: vi.fn(),
    updateEntry: vi.fn(),
  }),
}));

vi.mock('@/hooks/useIdempotentAction', () => ({
  useIdempotentAction: () => ({
    execute: async (fn: (key: string) => Promise<void>) => fn('synthetic-key'),
    isProcessing: false,
  }),
}));

vi.mock('@/hooks/useRtlDirection', () => ({
  useRtlDirection: () => ({ dir: 'ltr' }),
}));

vi.mock('@/lib/receipt', () => ({ downloadReceipt: vi.fn() }));

// Note: useAccessibleModal is deliberately NOT mocked. These tests verify the
// real focus trap and Escape behavior of the nested confirmation dialog.

function renderModal() {
  return render(
    <StellarFiatModal isOpen={true} onClose={vi.fn()} defaultAmount="100" />,
  );
}

async function fillRiskPhrase() {
  const input = await screen.findByLabelText(/Large amount confirmation phrase/i);
  fireEvent.change(input, { target: { value: 'CONFIRM LARGE AMOUNT' } });
}

async function openChallenge() {
  await fillRiskPhrase();
  fireEvent.click(screen.getByRole('button', { name: /^Deposit$/i }));
  return screen.findByTestId('two-factor-modal');
}

describe('Issue #290: amount → quote → confirmation accessibility', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    sessionExpired = false;
    mockVerifyIdentity.mockResolvedValue({ isValid: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('names inputs and announces the fiat quote for screen readers', async () => {
    renderModal();

    expect(screen.getByLabelText(/Amount \(XLM\)/i)).toHaveAttribute(
      'aria-describedby',
      'sfm-amount-hint',
    );
    expect(screen.getByText(/Enter the amount in XLM/i)).toHaveClass('sr-only');
    expect(screen.getByLabelText(/Optional note/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Large amount confirmation phrase/i)).toHaveAttribute(
      'aria-describedby',
      'sfm-risk-hint',
    );

    await waitFor(() => {
      expect(screen.getByText(/at current market rate/i)).toHaveAttribute('role', 'status');
    });
  });

  it('traps focus in the high-value challenge and closes it with Escape only', async () => {
    renderModal();
    const challenge = await openChallenge();

    expect(challenge).toHaveAttribute('role', 'dialog');
    expect(challenge).toHaveAttribute('aria-modal', 'true');
    expect(challenge).toHaveAccessibleName('Two-Factor Confirmation');
    expect(document.activeElement).toBe(
      within(challenge).getByLabelText(/Last 4 digits of wallet address/i),
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('two-factor-modal')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: 'Deposit to Bridge' })).toBeInTheDocument();
  });

  it('keeps invalid-challenge feedback inline and moves focus to review on success', async () => {
    renderModal();
    const challenge = await openChallenge();
    const input = within(challenge).getByLabelText(/Last 4 digits of wallet address/i);

    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.click(within(challenge).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(within(challenge).getByRole('alert')).toHaveTextContent('Enter at least 4 characters');
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('sfm-two-factor-error');

    fireEvent.change(input, { target: { value: '2345' } });
    expect(within(challenge).queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(within(challenge).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.queryByTestId('two-factor-modal')).not.toBeInTheDocument();
      expect(screen.getByTestId('pre-sign-summary')).toBeInTheDocument();
    });
    expect(document.activeElement).toBe(screen.getByTestId('confirm-sign-button'));
    expect(screen.getByText(/Review ready: Deposit of 100 XLM/i)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('region', { name: /Pre-sign transaction summary/i })).toBeInTheDocument();
  });

  it('does not reopen the challenge when the review action is confirmed', async () => {
    renderModal();
    const challenge = await openChallenge();
    fireEvent.change(
      within(challenge).getByLabelText(/Last 4 digits of wallet address/i),
      { target: { value: '2345' } },
    );
    fireEvent.click(within(challenge).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-sign-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('confirm-sign-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('two-factor-modal')).not.toBeInTheDocument();
    });
    expect(mockDepositToContract).toHaveBeenCalled();
  });

  it('requires the challenge again after Escape closes and reopens the dialog', async () => {
    const onClose = vi.fn();
    const view = render(
      <StellarFiatModal isOpen={true} onClose={onClose} defaultAmount="100" />,
    );
    const challenge = await openChallenge();

    fireEvent.change(
      within(challenge).getByLabelText(/Last 4 digits of wallet address/i),
      { target: { value: '2345' } },
    );
    fireEvent.click(within(challenge).getByRole('button', { name: 'Confirm' }));
    await screen.findByTestId('confirm-sign-button');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    view.rerender(
      <StellarFiatModal isOpen={false} onClose={onClose} defaultAmount="100" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('stellar-fiat-modal')).not.toBeInTheDocument();
    });

    view.rerender(
      <StellarFiatModal isOpen={true} onClose={onClose} defaultAmount="100" />,
    );
    await openChallenge();
    expect(screen.getByTestId('two-factor-modal')).toBeInTheDocument();
  });
});
