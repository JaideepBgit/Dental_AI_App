/**
 * Render helper: wraps a subject in the theme and a memory router, and injects
 * a fake api client through ApiProvider so no test touches the network.
 *
 * A signed-in ORTHODONTIST is the default session, since that is the role most
 * pages are written for. Pass `user` to render as an admin, or `user: null` to
 * exercise the signed-out path.
 */
import { ThemeProvider } from '@mui/material/styles';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { ApiProvider } from '../services/ApiProvider';
import { AuthProvider } from '../services/AuthProvider';
import theme from '../theme';

export const FAKE_ORTHODONTIST = {
  authenticated: true,
  id: 2,
  full_name: 'Doctor One',
  email: 'dr.test@practice.local',
  role: 'ORTHODONTIST',
  primary_location: 'Main Practice',
  is_active: true,
};

export const FAKE_ADMIN = {
  authenticated: true,
  id: 1,
  full_name: 'Administrator',
  email: 'admin@practice.local',
  role: 'ADMIN',
  primary_location: 'Main Practice',
  is_active: true,
};

/** An api client whose every method resolves to something harmless. */
export function makeFakeApi(overrides = {}) {
  return {
    baseUrl: '',
    fetchHealth: vi.fn(async () => ({ status: 'ok', whisper: 'ready', model: {} })),
    // Auth surface. fetchMe resolving means "signed in"; renderWithProviders
    // overrides it to reject when a test asks for an anonymous session.
    fetchMe: vi.fn(async () => FAKE_ORTHODONTIST),
    login: vi.fn(async () => FAKE_ORTHODONTIST),
    logout: vi.fn(async () => ({ status: 'ok' })),
    changePassword: vi.fn(async () => ({ status: 'ok' })),
    fetchUsers: vi.fn(async () => []),
    createUser: vi.fn(async () => FAKE_ORTHODONTIST),
    updateUser: vi.fn(async () => FAKE_ORTHODONTIST),
    deactivateUser: vi.fn(async () => ({ status: 'deactivated' })),
    fetchLocations: vi.fn(async () => []),
    createLocation: vi.fn(async () => ({ id: 1, name: 'Main Practice', is_active: true })),
    updateLocation: vi.fn(async () => ({ id: 1, name: 'Main Practice', is_active: true })),
    fetchAuditLog: vi.fn(async () => []),
    assignXray: vi.fn(async (xrayId, userId) => ({
      xray_id: xrayId, assigned_to_id: userId ?? null, assigned_to: null,
    })),
    assignXraysBulk: vi.fn(async (xrayIds) => ({
      assigned: (xrayIds || []).length, assigned_to: null, not_found: [],
    })),
    fetchStats: vi.fn(async () => ({
      pending: 0, awaiting_review: 0, approved: 0, failed: 0,
      total: 0, third_molars_flagged: 0, patients: 0,
    })),
    fetchQueue: vi.fn(async () => ({ count: 0, items: [] })),
    fetchXray: vi.fn(async () => null),
    retryXray: vi.fn(async () => ({ status: 'PENDING' })),
    deleteXray: vi.fn(async () => ({ status: 'deleted', deleted_detections: 0 })),
    deletePatient: vi.fn(async () => ({ status: 'deleted', deleted_xrays: 0 })),
    fetchPatients: vi.fn(async () => ({ count: 0, items: [] })),
    fetchPatient: vi.fn(async () => ({ mrn: 'MRN-1', name: 'Test', xrays: [] })),
    fetchReferrals: vi.fn(async () => ({ count: 0, items: [] })),
    uploadXray: vi.fn(async () => ({ xray_id: 1, status: 'PENDING' })),
    transcribeAudio: vi.fn(async () => ''),
    approveCase: vi.fn(async () => ({ marked_for_extraction: 0 })),
    xrayImageUrl: (id) => `/api/xray/${id}/image`,
    referralUrl: (id) => `/api/referral/${id}`,
    ...overrides,
  };
}

export function renderWithProviders(
  ui,
  { route = '/', api = makeFakeApi(), user = FAKE_ORTHODONTIST } = {},
) {
  // A null user means signed out: AuthProvider treats a rejected fetchMe as the
  // anonymous state, which is exactly what the real 401 produces.
  if (user === null) {
    api.fetchMe = vi.fn(async () => {
      const err = new Error('Not signed in');
      err.status = 401;
      throw err;
    });
  } else if (user !== FAKE_ORTHODONTIST) {
    api.fetchMe = vi.fn(async () => user);
  }

  const result = render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[route]}>
        <ApiProvider client={api}>
          <AuthProvider>{ui}</AuthProvider>
        </ApiProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { ...result, api };
}
