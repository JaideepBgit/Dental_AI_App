/**
 * The sign-off panel's review-lock gating.
 *
 * Signing requires the lock, so the form that feeds a signature must be inert
 * until the doctor holds it. Letting them tick teeth, dictate a note and draw a
 * signature first, only to be refused at submit, wastes the whole review.
 */
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import CaseReviewPage from '../CaseReviewPage';
import {
  FAKE_ORTHODONTIST, makeFakeApi, renderWithProviders,
} from '../../test/renderWithProviders';

/** One case detail payload, defaulting to unclaimed and awaiting a decision. */
function caseDetail(overrides = {}) {
  return {
    id: 1,
    patient_name: 'Ada Patient',
    mrn: 'MRN-1',
    filename: 'pano.jpg',
    status: 'PROCESSED',
    appointment_date: null,
    width: 1200,
    height: 600,
    error_message: null,
    image_url: '/api/xray/1/image',
    detections: [{
      id: 10,
      class_name: '3rd_Molar',
      source: 'detect',
      fdi_number: '38',
      universal_number: '17',
      quadrant: 'Lower-Left',
      bbox: [10, 20, 60, 80],
      polygon: null,
      confidence: 0.91,
      impaction_type: null,
      needs_extraction: false,
      is_third_molar: true,
      disease: null,
      notes: null,
    }],
    referral: null,
    assigned_to_id: null,
    assigned_to: null,
    assigned_at: null,
    claimed_by_id: null,
    claimed_by: null,
    claimed_at: null,
    claimed_by_me: false,
    prescription: null,
    prescription_history: [],
    model: {},
    ...overrides,
  };
}

function renderCase(detail) {
  const api = makeFakeApi({ fetchXray: async () => detail });
  // Wrapped in a Route: the page reads its case id from useParams, so rendered
  // bare it loads nothing and the panel never appears.
  return renderWithProviders(
    <Routes>
      <Route path="/case/:id" element={<CaseReviewPage />} />
    </Routes>,
    { route: '/case/1', api, user: FAKE_ORTHODONTIST },
  );
}

const CLAIMED_BY_ME = {
  claimed_by_id: FAKE_ORTHODONTIST.id,
  claimed_by: FAKE_ORTHODONTIST.full_name,
  claimed_by_me: true,
};

describe('sign-off panel before the case is claimed', () => {
  it('offers a claim button instead of the sign button', async () => {
    renderCase(caseDetail());

    expect(await screen.findByRole('button', { name: /claim case to review/i }))
      .toBeEnabled();
    expect(screen.queryByRole('button', { name: /sign & record/i })).toBeNull();
  });

  it('disables the decision radios', async () => {
    renderCase(caseDetail());
    await screen.findByRole('button', { name: /claim case to review/i });

    expect(screen.getByRole('radio', { name: /extraction/i })).toBeDisabled();
  });

  it('disables the dictation note', async () => {
    renderCase(caseDetail());
    await screen.findByRole('button', { name: /claim case to review/i });

    expect(screen.getByPlaceholderText(/dictate or type/i)).toBeDisabled();
  });

  it('disables the extraction checkboxes', async () => {
    renderCase(caseDetail());
    await screen.findByRole('button', { name: /claim case to review/i });

    screen.getAllByRole('checkbox').forEach((box) => expect(box).toBeDisabled());
  });
});

describe('sign-off panel once the doctor holds the lock', () => {
  it('offers the sign button', async () => {
    renderCase(caseDetail(CLAIMED_BY_ME));

    expect(await screen.findByRole('button', { name: /sign & record/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /claim case to review/i })).toBeNull();
  });

  it('enables the decision radios and the note', async () => {
    renderCase(caseDetail(CLAIMED_BY_ME));
    await screen.findByRole('button', { name: /sign & record/i });

    expect(screen.getByRole('radio', { name: /extraction/i })).toBeEnabled();
    expect(screen.getByPlaceholderText(/dictate or type/i)).toBeEnabled();
  });

  it('offers a release escape hatch', async () => {
    renderCase(caseDetail(CLAIMED_BY_ME));

    expect(await screen.findByRole('button', { name: /release without signing/i }))
      .toBeEnabled();
  });
});

describe('sign-off panel when a colleague holds the lock', () => {
  const HELD = {
    claimed_by_id: 99,
    claimed_by: 'Dr Colleague',
    claimed_by_me: false,
  };

  it('names the holder and disables claiming', async () => {
    renderCase(caseDetail(HELD));

    expect(await screen.findByRole('button', { name: /under review by dr colleague/i }))
      .toBeDisabled();
  });

  it('keeps the form inert', async () => {
    renderCase(caseDetail(HELD));
    await screen.findByRole('button', { name: /under review by dr colleague/i });

    expect(screen.getByRole('radio', { name: /extraction/i })).toBeDisabled();
    expect(screen.getByPlaceholderText(/dictate or type/i)).toBeDisabled();
  });
});
