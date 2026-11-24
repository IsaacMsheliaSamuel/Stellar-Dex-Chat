import React, { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAccessibleModal } from '../useAccessibleModal';

function Harness({
  suspended,
  onClose,
}: {
  suspended: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useAccessibleModal(true, ref, onClose, { suspended });
  return (
    <div ref={ref} role="dialog" aria-label="Parent dialog">
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  );
}

describe('useAccessibleModal suspended option', () => {
  it('pauses parent keyboard handling while a nested dialog owns focus', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness suspended={false} onClose={onClose} />);

    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Harness suspended={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Tab is not hijacked by the suspended parent trap.
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(last);

    rerender(<Harness suspended={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
