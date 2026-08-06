/**
 * The app shell: a persistent nav rail plus routed pages.
 *
 * The point of these tests is that the app no longer looks like one screen —
 * every destination is reachable and visible from anywhere.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import AppRoutes from '../../AppRoutes';
import {
  FAKE_ADMIN, FAKE_ORTHODONTIST, makeFakeApi, renderWithProviders,
} from '../../test/renderWithProviders';

// Routes now sit behind RequireAuth, so the shared helper is used for its
// AuthProvider: without a session every route would redirect to /login.
//
// Admin is the default session here because these are whole-app tests and an
// admin is the only role that can reach every destination. Doctor scoping has
// its own describe block at the bottom.
function renderApp({ route = '/', api = makeFakeApi(), user = FAKE_ADMIN } = {}) {
  return renderWithProviders(<AppRoutes />, { route, api, user });
}

const DESTINATIONS = [
  'Dashboard', 'New Case', 'Review Queue', 'Patients', 'Referrals', 'Settings',
];

describe('app shell navigation', () => {
  it('shows every destination in the nav', async () => {
    renderApp();

    const nav = await screen.findByRole('navigation');
    DESTINATIONS.forEach((label) => {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    });
    expect(nav).toBeInTheDocument();
  });

  it('lands on the dashboard, not the queue', async () => {
    renderApp({ route: '/' });

    expect(await screen.findByRole('heading', { name: /dashboard|overview/i }))
      .toBeInTheDocument();
  });

  it('navigates to the intake page from the nav', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/' });

    const link = (await screen.findAllByRole('link', { name: /new case/i }))[0];
    await user.click(link);

    expect(await screen.findByRole('heading', { name: /new case/i })).toBeInTheDocument();
  });

  it('renders the queue page at /queue', async () => {
    renderApp({ route: '/queue' });

    expect(await screen.findByRole('heading', { name: /review queue/i })).toBeInTheDocument();
  });

  it('renders the patients page at /patients', async () => {
    renderApp({ route: '/patients' });

    expect(await screen.findByRole('heading', { name: /patients/i })).toBeInTheDocument();
  });

  it('renders the referrals page at /referrals', async () => {
    renderApp({ route: '/referrals' });

    expect(await screen.findByRole('heading', { name: /referrals/i })).toBeInTheDocument();
  });

  it('renders the settings page at /settings', async () => {
    renderApp({ route: '/settings' });

    expect(await screen.findByRole('heading', { name: /settings/i })).toBeInTheDocument();
  });

  it('loads a specific case at /case/:id', async () => {
    const api = makeFakeApi({
      fetchXray: async (id) => ({
        id: Number(id), patient_name: 'Patient One', mrn: 'MRN-A',
        filename: 'pano.png', status: 'PROCESSED', detections: [],
      }),
    });
    renderApp({ route: '/case/42', api });

    expect(await screen.findByText('Patient One')).toBeInTheDocument();
  });

  it('shows a not-found page for an unknown route', async () => {
    renderApp({ route: '/nowhere' });

    expect(await screen.findByRole('heading', { name: /page not found/i }))
      .toBeInTheDocument();
  });

  it('warns once when the backend is unreachable', async () => {
    const api = makeFakeApi({
      fetchHealth: async () => { throw new Error('ECONNREFUSED'); },
    });
    renderApp({ route: '/', api });

    expect(await screen.findByText(/cannot reach|unreachable|backend/i)).toBeInTheDocument();
  });
});

describe('DashboardPage', () => {
  it('shows the headline counts', async () => {
    const api = makeFakeApi({
      fetchStats: async () => ({
        pending: 2, awaiting_review: 5, approved: 9, failed: 1,
        total: 17, third_molars_flagged: 4, patients: 12,
      }),
    });
    renderApp({ route: '/', api });

    // Scoped to the tile: 'Awaiting review' also appears as the queue nav badge.
    const tile = (await screen.findAllByText(/awaiting review/i))[0].closest('a');
    await waitFor(() => expect(tile).toHaveTextContent('5'));

    const signedTile = screen.getByText(/signed off/i).closest('a');
    expect(signedTile).toHaveTextContent('9');
  });

  it('links to the intake page as a primary action', async () => {
    renderApp({ route: '/' });

    const links = await screen.findAllByRole('link', { name: /new case/i });
    expect(links.some((l) => l.getAttribute('href') === '/upload')).toBe(true);
  });
});

describe('PatientsPage delete', () => {
  const PATIENTS = [
    { mrn: 'MRN-X', name: 'Patient One', num_xrays: 4, num_approved: 2 },
  ];

  it('requires typing the mrn to delete a patient', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchPatients: vi.fn(async () => ({ count: 1, items: PATIENTS })),
    });
    renderApp({ route: '/patients', api });
    await screen.findByText('Patient One');

    await user.click(screen.getByRole('button', { name: /delete/i }));

    const confirm = screen.getByRole('button', { name: /delete patient/i });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/type mrn/i), 'MRN-X');
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    await waitFor(() => expect(api.deletePatient).toHaveBeenCalledWith('MRN-X'));
  });

  it('names how much will be destroyed', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchPatients: vi.fn(async () => ({ count: 1, items: PATIENTS })),
    });
    renderApp({ route: '/patients', api });
    await screen.findByText('Patient One');

    await user.click(screen.getByRole('button', { name: /delete/i }));

    // The count is the whole point of the warning.
    expect(screen.getByText(/4 radiograph/i)).toBeInTheDocument();
  });
});

describe('QueuePage', () => {
  const ITEMS = [
    {
      id: 1, patient_name: 'Patient One', mrn: 'MRN-A', status: 'PROCESSED',
      filename: 'a.png', num_detections: 30, num_third_molars: 2,
      marked_for_extraction: 0, appointment_date: '2026-08-10',
    },
    {
      id: 2, patient_name: 'Patient Two', mrn: 'MRN-C', status: 'ERROR',
      filename: 'c.png', num_detections: 0, num_third_molars: 0,
      marked_for_extraction: 0, error_message: 'model file corrupt',
    },
  ];

  it('lists every case with patient and mrn', async () => {
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: ITEMS.length, items: ITEMS })),
    });
    renderApp({ route: '/queue', api });

    expect(await screen.findByText('Patient One')).toBeInTheDocument();
    expect(screen.getByText('Patient Two')).toBeInTheDocument();
    expect(screen.getByText('MRN-A')).toBeInTheDocument();
  });

  it('filters by status through the api', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: ITEMS.length, items: ITEMS })),
    });
    renderApp({ route: '/queue', api });
    await screen.findByText('Patient One');

    await user.click(screen.getByRole('button', { name: /failed/i }));

    await waitFor(() => {
      expect(api.fetchQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'ERROR' }),
      );
    });
  });

  it('offers a retry on a failed case', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: 1, items: [ITEMS[1]] })),
    });
    renderApp({ route: '/queue', api });
    await screen.findByText('Patient Two');

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(api.retryXray).toHaveBeenCalledWith(2));
  });

  it('shows an empty state with a link to intake', async () => {
    renderApp({ route: '/queue' });

    expect(await screen.findByText(/no cases/i)).toBeInTheDocument();
  });

  it('offers no patient delete from the queue', async () => {
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: 1, items: [ITEMS[0]] })),
    });
    renderApp({ route: '/queue', api });
    await screen.findByText('Patient One');

    // Deleting a whole patient must not be reachable from a row being skimmed.
    expect(screen.queryByRole('button', { name: /delete patient/i })).not.toBeInTheDocument();
  });

  it('deletes an unsigned case after one confirm', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: 1, items: [ITEMS[0]] })),
    });
    renderApp({ route: '/queue', api });
    await screen.findByText('Patient One');

    await user.click(screen.getByRole('button', { name: /delete/i }));
    // No MRN gate on an unsigned case.
    expect(screen.queryByLabelText(/type mrn/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /delete case/i }));

    await waitFor(() => expect(api.deleteXray).toHaveBeenCalledWith(1));
  });

  it('requires typing the mrn to delete a signed case', async () => {
    const user = userEvent.setup();
    const signed = {
      ...ITEMS[0], id: 9, status: 'APPROVED', patient_name: 'Signed Patient', mrn: 'MRN-S',
    };
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: 1, items: [signed] })),
    });
    renderApp({ route: '/queue', api });
    await screen.findByText('Signed Patient');

    await user.click(screen.getByRole('button', { name: /delete/i }));

    const confirm = screen.getByRole('button', { name: /delete case/i });
    expect(confirm).toBeDisabled();
    expect(api.deleteXray).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/type mrn/i), 'MRN-S');
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    await waitFor(() => expect(api.deleteXray).toHaveBeenCalledWith(9));
  });

  it('does not delete when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({ count: 1, items: [ITEMS[0]] })),
    });
    renderApp({ route: '/queue', api });
    await screen.findByText('Patient One');

    await user.click(screen.getByRole('button', { name: /delete/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(api.deleteXray).not.toHaveBeenCalled();
  });

  it('renders the search box magnifier icon', async () => {
    // MUI 9 ignores the legacy InputProps, which silently drops adornments.
    renderApp({ route: '/queue' });

    const search = await screen.findByPlaceholderText(/search name or mrn/i);
    expect(search.closest('.MuiInputBase-root').querySelector('svg')).toBeTruthy();
  });
});

describe('role scoping', () => {
  // An orthodontist works only the cases an admin assigned to them, so the
  // practice-wide screens must be unreachable and the intake affordances absent.
  const DOCTOR_ONLY = ['Review Queue', 'Referrals', 'Settings'];
  const ADMIN_ONLY = ['Dashboard', 'New Case', 'Patients', 'Administration'];

  it('shows a doctor only their own destinations', async () => {
    renderApp({ route: '/queue', user: FAKE_ORTHODONTIST });

    const nav = await screen.findByRole('navigation');
    DOCTOR_ONLY.forEach((label) => {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    });
    ADMIN_ONLY.forEach((label) => {
      expect(within(nav).queryByText(label)).toBeNull();
    });
  });

  it('shows an admin every destination including Administration', async () => {
    renderApp({ route: '/', user: FAKE_ADMIN });

    const nav = await screen.findByRole('navigation');
    [...DOCTOR_ONLY, ...ADMIN_ONLY].forEach((label) => {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    });
  });

  it('sends a doctor from the dashboard route to their queue', async () => {
    renderApp({ route: '/', user: FAKE_ORTHODONTIST });

    expect(await screen.findByText(/cases assigned to you/i)).toBeInTheDocument();
  });

  it('redirects a doctor away from an admin-only route', async () => {
    renderApp({ route: '/patients', user: FAKE_ORTHODONTIST });

    // Bounced to the queue rather than shown the patient directory.
    expect(await screen.findByText(/cases assigned to you/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^patients$/i })).toBeNull();
  });

  it('hides the assignment column and intake button from a doctor', async () => {
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({
        count: 1,
        items: [{
          id: 5, patient_name: 'Patient One', mrn: 'MRN-5', filename: 'a.jpg',
          status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
          marked_for_extraction: 0, assigned_to_id: 2, assigned_to: 'Doctor One',
        }],
      })),
    });
    renderApp({ route: '/queue', api, user: FAKE_ORTHODONTIST });

    await screen.findByText('Patient One');
    // No assignment control: the row select and the filter are both admin-only.
    // (Matching on text would hit the "Cases assigned to you" subtitle.)
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('link', { name: /new case/i })).toBeNull();
    // Deleting a case is an admin action.
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    // The doctor list is only fetched for admins.
    expect(api.fetchUsers).not.toHaveBeenCalled();
  });

  it('gives an admin an assignment control per case and flags unassigned ones', async () => {
    const api = makeFakeApi({
      fetchUsers: vi.fn(async () => [
        { id: 2, full_name: 'Doctor One', role: 'ORTHODONTIST', is_active: true },
        { id: 1, full_name: 'Administrator', role: 'ADMIN', is_active: true },
      ]),
      fetchQueue: vi.fn(async () => ({
        count: 2,
        items: [
          {
            id: 5, patient_name: 'Patient One', mrn: 'MRN-5', filename: 'a.jpg',
            status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
            marked_for_extraction: 0, assigned_to_id: null, assigned_to: null,
          },
          {
            id: 6, patient_name: 'Patient Two', mrn: 'MRN-6', filename: 'b.jpg',
            status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
            marked_for_extraction: 0,
            assigned_to_id: 2, assigned_to: 'Doctor One',
          },
        ],
      })),
    });
    renderApp({ route: '/queue', api, user: FAKE_ADMIN });

    const unassignedRow = (await screen.findByText('Patient One')).closest('tr');
    const assignedRow = (await screen.findByText('Patient Two')).closest('tr');

    // Every row carries its own owner select, and the doctor list is fetched.
    await waitFor(() => expect(api.fetchUsers).toHaveBeenCalled());
    expect(within(unassignedRow).getByRole('combobox')).toBeInTheDocument();
    expect(within(assignedRow).getByRole('combobox')).toBeInTheDocument();

    // An unassigned case is called out; an assigned one names its owner.
    expect(within(unassignedRow).getByText(/unassigned/i)).toBeInTheDocument();
    expect(within(assignedRow).getByText('Doctor One')).toBeInTheDocument();
  });

  it('shows no save icon until an assignment is staged', async () => {
    const api = makeFakeApi({
      fetchUsers: vi.fn(async () => [
        { id: 2, full_name: 'Doctor One', role: 'ORTHODONTIST', is_active: true },
      ]),
      fetchQueue: vi.fn(async () => ({
        count: 1,
        items: [{
          id: 5, patient_name: 'Patient One', mrn: 'MRN-5', filename: 'a.jpg',
          status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
          marked_for_extraction: 0, assigned_to_id: null, assigned_to: null,
        }],
      })),
    });
    renderApp({ route: '/queue', api, user: FAKE_ADMIN });

    await screen.findByText('Patient One');
    await waitFor(() => expect(api.fetchUsers).toHaveBeenCalled());

    // Nothing staged yet, so no save/discard affordance and nothing written.
    expect(screen.queryByLabelText(/save assignment/i)).toBeNull();
    expect(screen.queryByLabelText(/discard assignment/i)).toBeNull();
    expect(screen.queryByText(/unsaved assignment change/i)).toBeNull();
    expect(api.assignXray).not.toHaveBeenCalled();
  });

  it('offers a bulk assign bar once cases are ticked', async () => {
    const api = makeFakeApi({
      fetchUsers: vi.fn(async () => [
        { id: 2, full_name: 'Doctor One', role: 'ORTHODONTIST', is_active: true },
      ]),
      fetchQueue: vi.fn(async () => ({
        count: 2,
        items: [
          {
            id: 5, patient_name: 'Patient One', mrn: 'MRN-5', filename: 'a.jpg',
            status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
            marked_for_extraction: 0, assigned_to_id: null, assigned_to: null,
          },
          {
            id: 6, patient_name: 'Patient Two', mrn: 'MRN-6', filename: 'b.jpg',
            status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
            marked_for_extraction: 0, assigned_to_id: null, assigned_to: null,
          },
        ],
      })),
    });
    const user = userEvent.setup();
    renderApp({ route: '/queue', api, user: FAKE_ADMIN });

    await screen.findByText('Patient One');

    // The bar is hidden until something is selected.
    expect(screen.queryByText(/selected/i)).toBeNull();

    await user.click(screen.getByLabelText(/select case for Patient One/i));
    expect(await screen.findByText(/1 selected/i)).toBeInTheDocument();

    // Select-all covers both rows.
    await user.click(screen.getByLabelText(/select all cases/i));
    expect(await screen.findByText(/2 selected/i)).toBeInTheDocument();
  });

  it('hides checkboxes and the bulk bar from a doctor', async () => {
    const api = makeFakeApi({
      fetchQueue: vi.fn(async () => ({
        count: 1,
        items: [{
          id: 5, patient_name: 'Patient One', mrn: 'MRN-5', filename: 'a.jpg',
          status: 'PROCESSED', num_detections: 4, num_third_molars: 2,
          marked_for_extraction: 0, assigned_to_id: 2, assigned_to: 'Doctor One',
        }],
      })),
    });
    renderApp({ route: '/queue', api, user: FAKE_ORTHODONTIST });

    await screen.findByText('Patient One');
    expect(screen.queryByLabelText(/select all cases/i)).toBeNull();
    expect(screen.queryByLabelText(/select case for/i)).toBeNull();
    expect(screen.queryByLabelText(/save assignment/i)).toBeNull();
  });
});
