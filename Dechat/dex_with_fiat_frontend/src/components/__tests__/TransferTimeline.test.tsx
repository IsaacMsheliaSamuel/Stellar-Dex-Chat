import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import TransferTimeline from '@/components/TransferTimeline';

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/useRtlDirection', () => ({
  useRtlDirection: () => ({ isRtl: false, dir: 'ltr' }),
}));

describe('TransferTimeline - skeleton loading state', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders skeleton when isLoading is true', () => {
    render(<TransferTimeline events={[]} isLoading={true} />);

    expect(screen.getByTestId('skeleton-timeline')).toBeTruthy();
  });

  it('does not render skeleton when isLoading is false with events', () => {
    render(
      <TransferTimeline
        events={[{ status: 'initiated', timestamp: new Date() }]}
        isLoading={false}
      />,
    );

    expect(screen.queryByTestId('skeleton-timeline')).toBeNull();
  });

  it('does not render skeleton when isLoading is false with no events', () => {
    render(<TransferTimeline events={[]} isLoading={false} />);

    expect(screen.queryByTestId('skeleton-timeline')).toBeNull();
    expect(screen.getByText('No status events yet.')).toBeTruthy();
  });

  it('renders skeleton instead of empty state when loading', () => {
    render(<TransferTimeline events={[]} isLoading={true} />);

    expect(screen.getByTestId('skeleton-timeline')).toBeTruthy();
    expect(screen.queryByText('No status events yet.')).toBeNull();
  });

  it('renders skeleton instead of events when loading with events', () => {
    render(
      <TransferTimeline
        events={[
          { status: 'initiated', timestamp: new Date() },
          { status: 'pending', timestamp: new Date() },
        ]}
        isLoading={true}
      />,
    );

    expect(screen.getByTestId('skeleton-timeline')).toBeTruthy();
    expect(screen.queryByText('Transfer initiated')).toBeNull();
  });

  it('renders events normally when not loading', () => {
    render(
      <TransferTimeline
        events={[{ status: 'success', timestamp: new Date() }]}
        isLoading={false}
      />,
    );

    expect(screen.queryByTestId('skeleton-timeline')).toBeNull();
    expect(screen.getByText('Transfer successful')).toBeTruthy();
  });
});

describe('TransferTimeline payout announcements (#291)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const event = (status: 'initiated' | 'pending' | 'success' | 'failed') => ({
    status,
    timestamp: '2026-11-24T10:00:00.000Z',
  });

  it('announces queued, processing and settled transitions in plain language', () => {
    const { rerender } = render(
      <TransferTimeline events={[event('initiated')]} />,
    );
    const region = screen.getByTestId('payout-status-live-region');

    expect(region).toHaveTextContent('Payout queued.');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');

    rerender(
      <TransferTimeline events={[event('initiated'), event('pending')]} />,
    );
    expect(region).toHaveTextContent('Payout processing.');

    rerender(
      <TransferTimeline
        events={[event('initiated'), event('pending'), event('success')]}
      />,
    );
    expect(region).toHaveTextContent('Payout settled.');
  });

  it('does not re-announce the same status on repeated polls or re-renders', () => {
    const events = [event('initiated')];
    const { rerender } = render(<TransferTimeline events={events} />);
    const region = screen.getByTestId('payout-status-live-region');

    expect(region).toHaveTextContent('Payout queued.');
    rerender(<TransferTimeline events={[...events]} />);
    rerender(<TransferTimeline events={[...events]} />);

    expect(region).toHaveTextContent('Payout queued.');
    expect(screen.getByTestId('payout-status-history')).toHaveAttribute(
      'data-announcement-count',
      '1',
    );
  });

  it('announces failures assertively', () => {
    render(<TransferTimeline events={[event('failed')]} />);
    const region = screen.getByTestId('payout-status-live-region');

    expect(region).toHaveTextContent('Payout failed.');
    expect(region).toHaveAttribute('role', 'alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces stale data instead of presenting it as settled', () => {
    const { rerender } = render(
      <TransferTimeline events={[event('pending')]} isStale={true} />,
    );
    const region = screen.getByTestId('payout-status-live-region');

    expect(region).toHaveTextContent(
      'Payout status is out of date. Refresh before acting.',
    );
    expect(screen.getByTestId('payout-status-stale')).toBeTruthy();

    // A terminal outcome remains authoritative even when the read model lags.
    rerender(<TransferTimeline events={[event('success')]} isStale={true} />);
    expect(region).toHaveTextContent('Payout settled.');
    expect(screen.queryByTestId('payout-status-stale')).toBeNull();
  });

  it('keeps the full history reviewable outside the live region', () => {
    render(
      <TransferTimeline
        events={[event('initiated'), event('pending'), event('success')]}
      />,
    );

    const history = screen.getByTestId('payout-status-history');
    expect(history).toHaveAttribute('aria-label', 'Payout status history');
    expect(history).toHaveAttribute('aria-live', 'off');
    expect(history.querySelectorAll('li')).toHaveLength(3);
    expect(
      screen.getByText(/Payout status history is not announced automatically/),
    ).toBeTruthy();
  });
});
