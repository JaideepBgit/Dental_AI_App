/**
 * The queue's review-lock affordances.
 *
 * A shared queue only works if the buttons tell the truth about what a click
 * will do. "Review" on a case a colleague holds is a dead end -- the backend
 * 403s -- and "Review" on an unclaimed case oversells it, since signing needs a
 * claim first. Each row's primary action must match what the server will allow.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import QueuePage from '../QueuePage';
import {
  FAKE_ORTHODONTIST, makeFakeApi, renderWithProviders,
} from '../../test/renderWithProviders';

/** One queue row, defaulting to an unclaimed case awaiting review. */
function caseRow(overrides = {}) {
  return {
    id: 1,
    patient_name: 'Ada Patient',
    mrn: 'MRN-1',
    filename: 'pano.jpg',
    status: 'PROCESSED',
    appointment_date: null,
    uploaded_at: '2026-08-01T10:00:00',
    decision: null,
    signed_by: null,
    signed_at: null,
    assigned_to_id: null,
    assigned_to: null,
    assigned_at: null,
    claimed_by_id: null,
    claimed_by: null,
    claimed_at: null,
    claimed_by_me: false,
    blocked_reason: null,
    num_detections: 4,
    num_third_molars: 1,
    marked_for_extraction: 0,
    error_message: null,
    ...overrides,
  };
}

function renderQueue(items, user = FAKE_ORTHODONTIST) {
  const api = makeFakeApi({
    fetchQueue: async () => ({ count: items.length, items }),
  });
  return renderWithProviders(<QueuePage />, { route: '/queue', api, user });
}

/** The row's action cell, where Claim / Release / Open / Review live. */
async function actionsFor(patientName) {
  const cell = await screen.findByText(patientName);
  return cell.closest('tr');
}

describe('queue row actions for a doctor', () => {
  it('offers Claim, and no Review, on an unclaimed case', async () => {
    renderQueue([caseRow()]);
    const row = await actionsFor('Ada Patient');

    expect(within(row).getByRole('button', { name: /claim/i })).toBeEnabled();
    // "Review" would imply the case is ready to sign, which it is not until
    // claimed. Opening it read-only is offered as "Open" instead.
    expect(within(row).queryByRole('link', { name: /^review$/i })).toBeNull();
    expect(within(row).getByRole('link', { name: /open/i })).toBeInTheDocument();
  });

  it('offers Review once the case is claimed by this doctor', async () => {
    renderQueue([caseRow({
      claimed_by_id: FAKE_ORTHODONTIST.id,
      claimed_by: FAKE_ORTHODONTIST.full_name,
      claimed_by_me: true,
    })]);
    const row = await actionsFor('Ada Patient');

    expect(within(row).getByRole('link', { name: /review/i })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /release/i })).toBeEnabled();
  });

  it('disables Claim and does not offer Review when a colleague holds it', async () => {
    renderQueue([caseRow({
      claimed_by_id: 99,
      claimed_by: 'Dr Colleague',
      claimed_by_me: false,
      blocked_reason: 'This case is under review by Dr Colleague.',
    })]);
    const row = await actionsFor('Ada Patient');

    expect(within(row).getByRole('button', { name: /claim/i })).toBeDisabled();
    // Read-only access is still allowed, so the link stays -- but it must not
    // promise a review the server will refuse.
    expect(within(row).queryByRole('link', { name: /^review$/i })).toBeNull();
    expect(within(row).getByRole('link', { name: /open/i })).toBeInTheDocument();
  });

  it('shows View, and no lock buttons, on a signed case', async () => {
    renderQueue([caseRow({ status: 'APPROVED', decision: 'MONITOR' })]);
    const row = await actionsFor('Ada Patient');

    expect(within(row).getByRole('link', { name: /view/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /claim/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /release/i })).toBeNull();
  });

  it('does not offer Claim on a case assigned to another doctor', async () => {
    renderQueue([caseRow({
      assigned_to_id: 99,
      assigned_to: 'Dr Colleague',
      blocked_reason: 'This case has been assigned to another orthodontist.',
    })]);
    const row = await actionsFor('Ada Patient');

    expect(within(row).getByRole('button', { name: /claim/i })).toBeDisabled();
  });
});
