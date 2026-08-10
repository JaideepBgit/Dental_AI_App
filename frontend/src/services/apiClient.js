/**
 * The one boundary between the UI and the backend.
 *
 * createApiClient is a factory over an HTTP transport rather than a module that
 * reaches for axios itself. Pages and hooks depend on the returned object, so
 * tests inject a stub and no component ever imports axios. Adding an endpoint
 * means adding a method here, not touching a component.
 */
import axios from 'axios';

// Set VITE_API_URL to point at a separately-hosted API. When it is defined but
// empty -- as in the container build, where FastAPI serves this bundle itself
// -- API_URL stays '' so every request is same-origin and relative. The
// localhost default only applies when the variable is absent entirely, i.e.
// `npm run dev` against a local backend on :8000.
const configuredApiUrl = import.meta.env.VITE_API_URL;

// Default to '' (same-origin). In dev, vite.config.js proxies /api to the
// backend, so requests stay same-origin and the session cookie is sent without
// CORS credential rules. Set VITE_API_URL only to target a separately-hosted API,
// which then also needs that origin in the backend's CORS_ORIGINS.
export const API_URL = configuredApiUrl === undefined ? '' : configuredApiUrl;

/** Pull a useful message out of a FastAPI error response. */
export function describeError(err, fallback = 'Request failed') {
  return err?.response?.data?.detail || err?.message || fallback;
}

/** Drop blank filters so they never reach the query string as empty params. */
function cleanParams(params) {
  const out = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed === '') return;
    out[key] = trimmed;
  });
  return out;
}

export function createApiClient({ transport, baseUrl = API_URL } = {}) {
  // withCredentials so the session cookie rides along on every request,
  // including the cross-origin case where VITE_API_URL is set explicitly.
  const http = transport || axios.create({ baseURL: baseUrl, withCredentials: true });

  /** Wrap a request so every caller sees an Error carrying the API's detail. */
  async function unwrap(promise, fallback) {
    try {
      const { data } = await promise;
      return data;
    } catch (err) {
      const error = new Error(describeError(err, fallback));
      if (err?.response?.status) error.status = err.response.status;
      // Lets the voice dictator fall back to browser speech recognition.
      if (err?.response?.status === 503) error.unavailable = true;
      throw error;
    }
  }

  /** Build a form body, dropping keys that are undefined/null/''. */
  function form(fields) {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      body.append(key, value);
    });
    return body;
  }

  return {
    baseUrl,

    fetchHealth: () =>
      unwrap(http.get('/api/health'), 'Could not reach the backend'),

    // --- authentication ---

    login: (email, password) =>
      unwrap(http.post('/api/login', form({ email, password })), 'Sign in failed'),

    logout: () => unwrap(http.post('/api/logout'), 'Sign out failed'),

    /** Resolves the current session. Throws with status 401 when signed out. */
    fetchMe: () => unwrap(http.get('/api/me'), 'Not signed in'),

    changePassword: (currentPassword, newPassword) =>
      unwrap(
        http.post('/api/change_password', form({
          current_password: currentPassword, new_password: newPassword,
        })),
        'Could not change password',
      ),

    // --- admin: users ---

    fetchUsers: () =>
      unwrap(http.get('/api/admin/users', { params: { include_inactive: true } }),
        'Could not load users'),

    createUser: ({ fullName, email, password, role, primaryLocationId }) =>
      unwrap(
        http.post('/api/admin/users', form({
          full_name: fullName, email, password, role,
          primary_location_id: primaryLocationId,
        })),
        'Could not create user',
      ),

    updateUser: (id, { fullName, primaryLocationId, isActive, role, password }) =>
      unwrap(
        http.patch(`/api/admin/users/${id}`, form({
          full_name: fullName,
          primary_location_id: primaryLocationId,
          // Booleans must survive the blank-dropping filter above.
          is_active: isActive === undefined ? undefined : String(isActive),
          role,
          password,
        })),
        'Could not update user',
      ),

    deactivateUser: (id) =>
      unwrap(http.delete(`/api/admin/users/${id}`), 'Could not deactivate user'),

    // --- admin: locations ---

    fetchLocations: () =>
      unwrap(http.get('/api/admin/locations', { params: { include_inactive: true } }),
        'Could not load locations'),

    createLocation: (name) =>
      unwrap(http.post('/api/admin/locations', form({ name })),
        'Could not create location'),

    updateLocation: (id, { name, isActive }) =>
      unwrap(
        http.patch(`/api/admin/locations/${id}`, form({
          name, is_active: isActive === undefined ? undefined : String(isActive),
        })),
        'Could not update location',
      ),

    fetchAuditLog: (limit = 200) =>
      unwrap(http.get('/api/admin/audit', { params: { limit } }),
        'Could not load the activity log'),

    // --- reusable e-signatures (per-clinician, self-service) ---

    fetchSignatures: () =>
      unwrap(http.get('/api/signatures'), 'Could not load your signatures'),

    /**
     * Save a reusable signature from EITHER an uploaded image file OR a drawn
     * data URL — pass one, not both. The first one saved becomes the default.
     */
    createSignature: ({ label, file, imageData, makeDefault }) => {
      const body = new FormData();
      body.append('label', label);
      if (file) body.append('file', file);
      if (imageData) body.append('image_data', imageData);
      body.append('make_default', String(Boolean(makeDefault)));
      return unwrap(http.post('/api/signatures', body), 'Could not save the signature');
    },

    updateSignature: (id, { label, makeDefault }) =>
      unwrap(
        http.patch(`/api/signatures/${id}`, form({
          label,
          make_default: makeDefault === undefined ? undefined : String(makeDefault),
        })),
        'Could not update the signature',
      ),

    deleteSignature: (id) =>
      unwrap(http.delete(`/api/signatures/${id}`), 'Could not delete the signature'),

    /** Signature image URL, for <img>. Session-scoped and never cached. */
    signatureImageUrl: (id) => `${baseUrl}/api/signatures/${id}/image`,

    // --- review locks (shared queue) ---

    /** Take the review lock so colleagues cannot work this case concurrently. */
    claimXray: (id) =>
      unwrap(http.post(`/api/xray/${id}/claim`), 'Could not claim the case'),

    /** Give the case back to the shared queue. Admins can force-release. */
    releaseXray: (id) =>
      unwrap(http.post(`/api/xray/${id}/release`), 'Could not release the case'),

    // --- admin: case assignment ---

    /** Assign one case. Pass userId null/undefined to unassign it. */
    assignXray: (xrayId, userId) =>
      unwrap(
        http.post(`/api/admin/xray/${xrayId}/assign`, form({ user_id: userId })),
        'Could not assign the case',
      ),

    /** Assign many at once. Pass userId null/undefined to unassign them. */
    assignXraysBulk: (xrayIds, userId) =>
      unwrap(
        http.post('/api/admin/assign_bulk', form({
          xray_ids: JSON.stringify(xrayIds || []),
          user_id: userId,
        })),
        'Could not assign the cases',
      ),

    fetchStats: () =>
      unwrap(http.get('/api/stats'), 'Could not load statistics'),

    /**
     * The case queue. Filters: scope ('unworked'|'completed'), status, search,
     * and (admin only) assigned ('unassigned'|'mine'|<userId>).
     *
     * A doctor's results are scoped to their own assigned cases by the backend,
     * so no filter here can widen what they see.
     */
    fetchQueue: (filters = {}) =>
      unwrap(
        http.get('/api/queue', { params: cleanParams(filters) }),
        'Could not load the queue',
      ),

    fetchXray: (id) =>
      unwrap(http.get(`/api/xray/${id}`), 'Could not load the case'),

    retryXray: (id) =>
      unwrap(http.post(`/api/xray/${id}/retry`), 'Retry failed'),

    /** Permanently deletes one case, its findings, referrals and files. */
    deleteXray: (id) =>
      unwrap(http.delete(`/api/xray/${id}`), 'Could not delete the case'),

    /** Permanently deletes a patient and every radiograph they have. */
    deletePatient: (mrn) =>
      unwrap(http.delete(`/api/patients/${mrn}`), 'Could not delete the patient'),

    fetchPatients: (filters = {}) =>
      unwrap(
        http.get('/api/patients', { params: cleanParams(filters) }),
        'Could not load patients',
      ),

    fetchPatient: (mrn) =>
      unwrap(http.get(`/api/patients/${mrn}`), 'Could not load the patient'),

    fetchReferrals: (filters = {}) =>
      unwrap(
        http.get('/api/referrals', { params: cleanParams(filters) }),
        'Could not load referrals',
      ),

    uploadXray: ({ file, patientName, mrn, appointmentDate, onProgress }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('patient_name', patientName || 'Unknown Patient');
      form.append('mrn', mrn || '');
      form.append('appointment_date', appointmentDate || '');

      return unwrap(
        http.post('/api/upload', form, {
          onUploadProgress: (event) => {
            if (!onProgress || !event?.total) return;
            onProgress(Math.round((event.loaded / event.total) * 100));
          },
        }),
        'Upload failed',
      );
    },

    transcribeAudio: async (blob) => {
      const form = new FormData();
      form.append('audio', blob, 'note.webm');
      const data = await unwrap(
        http.post('/api/transcribe', form), 'Transcription failed',
      );
      return data.text || '';
    },

    /**
     * Record a signed clinical decision.
     *
     * There is no doctorName parameter: the signing clinician and the timestamp
     * come from the authenticated session on the server, so the client cannot
     * sign as somebody else. `decision` is EXTRACT | REFER | MONITOR |
     * NO_ACTION_NEEDED. Pass amendsId to correct an already-signed case.
     *
     * Sign with EITHER signatureId (one of the clinician's saved signatures,
     * the normal path) OR a freshly drawn `signature` data URL.
     */
    approveCase: ({ xrayId, decision, prescriptionText, signature, signatureId,
                    extractionIds, dictationText, reviewedAt, amendsId }) =>
      unwrap(
        http.post('/api/approve', form({
          xray_id: xrayId,
          decision,
          prescription_text: prescriptionText,
          signature,
          signature_id: signatureId,
          extraction_ids: JSON.stringify(extractionIds || []),
          dictation_text: dictationText,
          reviewed_at: reviewedAt,
          amends_id: amendsId,
        })),
        'Approval failed',
      ),

    // Plain URLs for <img> and <a href>, which cannot go through the transport.
    xrayImageUrl: (id) => `${baseUrl}/api/xray/${id}/image`,
    referralUrl: (id) => `${baseUrl}/api/referral/${id}`,
  };
}

/** The instance the running app uses. Tests build their own. */
export const apiClient = createApiClient();
