/**
 * The gate in front of every destructive action.
 *
 * Ordinary deletes take one confirm. A delete that destroys a signed referral
 * or a whole patient requires typing the MRN, so it cannot happen by reflex.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ConfirmDeleteDialog from '../ConfirmDeleteDialog';
import { renderWithProviders } from '../../test/renderWithProviders';

const base = {
  open: true,
  title: 'Delete this case?',
  description: 'This permanently removes the radiograph and its findings.',
  confirmLabel: 'Delete case',
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
};

describe('ConfirmDeleteDialog', () => {
  it('shows the title and description', () => {
    renderWithProviders(<ConfirmDeleteDialog {...base} />);

    expect(screen.getByText('Delete this case?')).toBeInTheDocument();
    expect(screen.getByText(/permanently removes/i)).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    renderWithProviders(<ConfirmDeleteDialog {...base} open={false} />);

    expect(screen.queryByText('Delete this case?')).not.toBeInTheDocument();
  });

  it('confirms immediately when no mrn gate is required', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmDeleteDialog {...base} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: /delete case/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without confirming', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmDeleteDialog {...base} onCancel={onCancel} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  describe('when an mrn must be typed', () => {
    const gated = { ...base, requireMrn: 'MRN-9001' };

    it('disables confirm until the mrn matches', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ConfirmDeleteDialog {...gated} />);

      const button = screen.getByRole('button', { name: /delete case/i });
      expect(button).toBeDisabled();

      await user.type(screen.getByLabelText(/type mrn/i), 'MRN-9001');

      await waitFor(() => expect(button).toBeEnabled());
    });

    it('stays disabled for a wrong mrn', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ConfirmDeleteDialog {...gated} />);

      await user.type(screen.getByLabelText(/type mrn/i), 'MRN-0000');

      expect(screen.getByRole('button', { name: /delete case/i })).toBeDisabled();
    });

    it('ignores surrounding whitespace and case', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ConfirmDeleteDialog {...gated} />);

      await user.type(screen.getByLabelText(/type mrn/i), '  mrn-9001  ');

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /delete case/i })).toBeEnabled());
    });

    it('does not confirm while the gate is unmet', async () => {
      const onConfirm = vi.fn();
      renderWithProviders(<ConfirmDeleteDialog {...gated} onConfirm={onConfirm} />);

      // The button is disabled, so userEvent refuses to click it at all.
      // fireEvent dispatches regardless, proving the handler itself also
      // refuses rather than relying on the disabled attribute alone.
      fireEvent.click(screen.getByRole('button', { name: /delete case/i }));

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('clears the typed value when reopened', async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithProviders(<ConfirmDeleteDialog {...gated} />);

      await user.type(screen.getByLabelText(/type mrn/i), 'MRN-9001');
      rerender(<ConfirmDeleteDialog {...gated} open={false} />);
      rerender(<ConfirmDeleteDialog {...gated} open />);

      // A stale match would let the next delete through with no typing at all.
      expect(screen.getByRole('button', { name: /delete case/i })).toBeDisabled();
    });
  });

  it('shows a busy state and blocks repeat clicks while deleting', () => {
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmDeleteDialog {...base} busy onConfirm={onConfirm} />);

    const button = screen.getByRole('button', { name: /deleting/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows an error returned by the caller', () => {
    renderWithProviders(
      <ConfirmDeleteDialog {...base} error="a signed referral cannot be deleted" />,
    );

    expect(screen.getByText(/signed referral/i)).toBeInTheDocument();
  });
});
