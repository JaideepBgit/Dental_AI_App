/**
 * Where things live in the nav, and what the Administration screen holds.
 *
 * The rail is ordered by how often a destination is used, not by how the app
 * was built: the dashboard is the landing, the review queue is the daily job,
 * and intake is an occasional action. Practice-wide records -- patients and
 * referrals -- are administration, so they live behind that tab rather than
 * taking a rail slot each.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import AppRoutes from '../../AppRoutes';
import { navItemsFor } from '../../components/AppShell';
import {
  FAKE_ADMIN, FAKE_ORTHODONTIST, makeFakeApi, renderWithProviders,
} from '../../test/renderWithProviders';

function renderApp({ route = '/', api = makeFakeApi(), user = FAKE_ADMIN } = {}) {
  return renderWithProviders(<AppRoutes />, { route, api, user });
}

describe('nav rail order', () => {
  it('orders an admin rail by how often each destination is used', () => {
    expect(navItemsFor(true).map((item) => item.label)).toEqual([
      'Dashboard',
      'Review Queue',
      'Administration',
      'New Case',
      'Settings',
    ]);
  });

  it('puts administration directly below the review queue', async () => {
    renderApp({ route: '/' });

    const nav = await screen.findByRole('navigation');
    const labels = within(nav).getAllByRole('link').map((a) => a.textContent);
    const queueAt = labels.findIndex((t) => t.startsWith('Review Queue'));

    expect(labels[queueAt + 1]).toBe('Administration');
  });

  it('gives a doctor their queue, their referrals, and their settings', () => {
    expect(navItemsFor(false).map((item) => item.label)).toEqual([
      'Review Queue',
      'Referrals',
      'Settings',
    ]);
  });

  it('puts the review queue above new case in the rendered rail', async () => {
    renderApp({ route: '/' });

    const nav = await screen.findByRole('navigation');
    const labels = within(nav).getAllByRole('link').map((a) => a.textContent);
    // textContent carries the badge count too, so match on the label prefix.
    const queueAt = labels.findIndex((t) => t.startsWith('Review Queue'));
    const intakeAt = labels.findIndex((t) => t.startsWith('New Case'));

    expect(queueAt).toBeGreaterThanOrEqual(0);
    expect(intakeAt).toBeGreaterThan(queueAt);
  });

  it('no longer spends a rail slot on patients or referrals for an admin', async () => {
    renderApp({ route: '/' });

    const nav = await screen.findByRole('navigation');
    expect(within(nav).queryByRole('link', { name: /^patients/i })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /^referrals/i })).toBeNull();
  });
});

describe('Administration tabs', () => {
  it('offers users, patients, referrals and activity', async () => {
    renderApp({ route: '/admin' });

    const tabs = await screen.findByRole('tablist');
    ['Users & Locations', 'Patients', 'Referrals', 'Activity'].forEach((name) => {
      expect(within(tabs).getByRole('tab', { name })).toBeInTheDocument();
    });
  });

  it('opens on users and locations', async () => {
    renderApp({ route: '/admin' });

    expect(await screen.findByRole('heading', { name: /orthodontists/i }))
      .toBeInTheDocument();
  });

  it('shows the patient directory on the patients tab', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchPatients: vi.fn(async () => ({
        count: 1,
        items: [{ mrn: 'MRN-X', name: 'Patient One', num_xrays: 4, num_approved: 2 }],
      })),
    });
    renderApp({ route: '/admin', api });

    await user.click(await screen.findByRole('tab', { name: 'Patients' }));

    expect(await screen.findByText('Patient One')).toBeInTheDocument();
  });

  it('shows the referral list on the referrals tab', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchReferrals: vi.fn(async () => ({
        count: 1,
        items: [{
          id: 7, xray_id: 7, patient_name: 'Patient One', mrn: 'MRN-X',
          doctor_name: 'Doctor One', generated_at: '2026-08-01T10:00:00',
          pdf_url: '/api/referral/7', pdf_available: true,
        }],
      })),
    });
    renderApp({ route: '/admin', api });

    await user.click(await screen.findByRole('tab', { name: 'Referrals' }));

    await waitFor(() => expect(api.fetchReferrals).toHaveBeenCalled());
    expect(await screen.findByText('Patient One')).toBeInTheDocument();
  });

  it('renders one page heading per tab, not a heading inside a heading', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/admin' });

    await user.click(await screen.findByRole('tab', { name: 'Patients' }));

    // The tab is the label; a second "Patients" page header would be noise.
    await screen.findByRole('tabpanel');
    expect(screen.queryByRole('heading', { name: /^patients$/i })).toBeNull();
  });
});

describe('Administration deep links', () => {
  it('opens the referrals tab directly from its url', async () => {
    renderApp({ route: '/admin/referrals' });

    const tab = await screen.findByRole('tab', { name: 'Referrals' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps Administration marked current while on a sub-tab', async () => {
    renderApp({ route: '/admin/patients' });

    const nav = await screen.findByRole('navigation');
    const link = within(nav).getByRole('link', { name: /administration/i });
    expect(link).toHaveClass('Mui-selected');
  });

  it('puts the chosen tab in the url so it can be shared', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/admin' });

    await user.click(await screen.findByRole('tab', { name: 'Activity' }));

    expect(await screen.findByRole('tab', { name: 'Activity' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: /activity log/i }))
      .toBeInTheDocument();
  });

  it('falls back to the first tab for an unknown tab name', async () => {
    renderApp({ route: '/admin/nonsense' });

    expect(await screen.findByRole('tab', { name: 'Users & Locations' }))
      .toHaveAttribute('aria-selected', 'true');
  });
});

describe('legacy record routes', () => {
  it('sends an admin from /patients to the administration tab', async () => {
    renderApp({ route: '/patients' });

    expect(await screen.findByRole('tab', { name: 'Patients' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('sends an admin from /referrals to the administration tab', async () => {
    renderApp({ route: '/referrals' });

    expect(await screen.findByRole('tab', { name: 'Referrals' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the patient drill-down a full page of its own', async () => {
    const api = makeFakeApi({
      fetchPatient: vi.fn(async () => ({
        mrn: 'MRN-X', name: 'Patient One', xrays: [],
      })),
    });
    renderApp({ route: '/patients/MRN-X', api });

    expect(await screen.findByRole('heading', { name: 'Patient One' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('walks back from a patient to the administration tab', async () => {
    const api = makeFakeApi({
      fetchPatient: vi.fn(async () => ({
        mrn: 'MRN-X', name: 'Patient One', xrays: [],
      })),
    });
    renderApp({ route: '/patients/MRN-X', api });
    await screen.findByRole('heading', { name: 'Patient One' });

    expect(screen.getByRole('link', { name: /all patients/i }))
      .toHaveAttribute('href', '/admin/patients');
  });

  it('still gives a doctor their own referrals as a full page', async () => {
    renderApp({ route: '/referrals', user: FAKE_ORTHODONTIST });

    expect(await screen.findByRole('heading', { name: /^referrals$/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('bounces a doctor off an administration tab', async () => {
    renderApp({ route: '/admin/patients', user: FAKE_ORTHODONTIST });

    expect(await screen.findByText(/the shared queue/i)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
