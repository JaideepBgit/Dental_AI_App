/**
 * Practice administration: orthodontists, locations, patients, referrals and
 * the activity log, split across tabs.
 *
 * Patients and Referrals are the practice's records rather than daily
 * destinations, so they live here as tabs instead of taking a nav rail slot
 * each. The pages themselves are reused as-is -- this file only frames them.
 *
 * The active tab is the URL (`/admin/patients`), not component state, so a tab
 * can be linked, bookmarked, and reached with the browser's back button.
 *
 * Admin-only. Users are deactivated rather than deleted so past sign-offs always
 * resolve to the clinician who made them.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogContentText, DialogTitle, IconButton, MenuItem, Paper,
  Snackbar, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import KeyIcon from '@mui/icons-material/Key';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import { useNavigate, useParams } from 'react-router-dom';

import PageHeader from '../components/PageHeader';
import PatientsPage from './PatientsPage';
import ReferralsPage from './ReferralsPage';
import { useApi } from '../services/ApiProvider';
import { useAuth } from '../services/AuthProvider';

/**
 * Tab order is the order an admin needs them: the people who use the system,
 * then the records they produce, then the log of what happened.
 *
 * `slug` is the URL segment. The first tab is the bare `/admin`, so its slug is
 * empty and anything unrecognised falls back to it.
 */
const TABS = [
  { slug: '', label: 'Users & Locations' },
  { slug: 'patients', label: 'Patients' },
  { slug: 'referrals', label: 'Referrals' },
  { slug: 'activity', label: 'Activity' },
];

function tabIndexFor(slug) {
  const found = TABS.findIndex((t) => t.slug === (slug || ''));
  return found === -1 ? 0 : found;
}

const ROLES = [
  { value: 'ORTHODONTIST', label: 'Orthodontist' },
  { value: 'ADMIN', label: 'Administrator' },
];

const EMPTY_NEW_USER = {
  fullName: '', email: '', password: '', role: 'ORTHODONTIST', primaryLocationId: '',
};

function fmt(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+$/, '').slice(0, 16);
}

/**
 * The tab frame. Only the selected panel is mounted, so switching to Patients
 * is what triggers its fetch -- nothing loads records the admin never opens.
 */
export default function AdminPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const current = tabIndexFor(tab);

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Administration"
        subtitle="Orthodontists, locations, patient records and practice activity."
      />

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs
          value={current}
          onChange={(_, next) => {
            const { slug } = TABS[next];
            navigate(slug ? `/admin/${slug}` : '/admin');
          }}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Administration sections"
        >
          {TABS.map((t) => (
            <Tab
              key={t.label}
              label={t.label}
              id={`admin-tab-${t.slug || 'users'}`}
              aria-controls={`admin-panel-${t.slug || 'users'}`}
              sx={{ textTransform: 'none', fontWeight: 500 }}
            />
          ))}
        </Tabs>
      </Box>

      <Box
        role="tabpanel"
        id={`admin-panel-${TABS[current].slug || 'users'}`}
        aria-labelledby={`admin-tab-${TABS[current].slug || 'users'}`}
      >
        {current === 0 && <PracticePanel />}
        {/* Both pages drop their own header: the tab already names the panel. */}
        {current === 1 && <PatientsPage embedded />}
        {current === 2 && <ReferralsPage embedded />}
        {current === 3 && <ActivityPanel />}
      </Box>
    </Box>
  );
}

/** Orthodontists and locations -- who can sign in, and where they work. */
function PracticePanel() {
  const api = useApi();
  const { user: me } = useAuth();

  const [users, setUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  // Row-level edits are staged here so a mistyped name is not saved until Save.
  const [edits, setEdits] = useState({});
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [showAdd, setShowAdd] = useState(false);
  const [newLocation, setNewLocation] = useState('');
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, l] = await Promise.all([api.fetchUsers(), api.fetchLocations()]);
      setUsers(u);
      setLocations(l);
      setEdits({});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function stage(id, field, value) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  async function run(fn, successMessage) {
    try {
      await fn();
      setToast(successMessage);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const activeLocations = locations.filter((l) => l.is_active);

  return (
    <Box>
      {error && (
        <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Stack spacing={3}>
          {/* ---------------- orthodontists ---------------- */}
          <Paper variant="outlined">
            {/* space-between alone only separates these while the row has slack;
                once it is tight the heading and button meet. spacing keeps a
                floor under the gap, and the button holds its width so the label
                wraps rather than the control squashing. */}
            <Stack
              direction="row" alignItems="center" justifyContent="space-between"
              spacing={2}
              sx={{ p: 2, pb: 1 }}
            >
              <Typography variant="h6">Orthodontists</Typography>
              <Button
                startIcon={<AddIcon />}
                variant="contained"
                size="small"
                disableElevation
                onClick={() => setShowAdd((v) => !v)}
                sx={{ flexShrink: 0 }}
              >
                Add orthodontist
              </Button>
            </Stack>

            {showAdd && (
              <Box sx={{ px: 2, pb: 2 }}>
                <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.default' }}>
                  <Stack spacing={2}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <TextField
                        label="Name" size="small" fullWidth required
                        placeholder="Doctor Name"
                        value={newUser.fullName}
                        onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })}
                      />
                      {/* Not type="email": a login may be a bare username. */}
                      <TextField
                        label="Username" size="small" fullWidth required
                        placeholder="username"
                        value={newUser.email}
                        onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                      />
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <TextField
                        label="Primary location" size="small" fullWidth select
                        value={newUser.primaryLocationId}
                        onChange={(e) => setNewUser({ ...newUser, primaryLocationId: e.target.value })}
                      >
                        <MenuItem value="">— none —</MenuItem>
                        {activeLocations.map((l) => (
                          <MenuItem key={l.id} value={l.id}>{l.name}</MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        label="Role" size="small" fullWidth select
                        value={newUser.role}
                        onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                      >
                        {ROLES.map((r) => (
                          <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>
                        ))}
                      </TextField>
                    </Stack>
                    <TextField
                      label="Temporary password" size="small" fullWidth required
                      helperText="At least 4 characters."
                      value={newUser.password}
                      onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    />
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="contained" size="small" disableElevation
                        onClick={() => run(
                          async () => {
                            await api.createUser(newUser);
                            setNewUser(EMPTY_NEW_USER);
                            setShowAdd(false);
                          },
                          'Orthodontist created. Share the temporary password securely.',
                        )}
                      >
                        Create
                      </Button>
                      <Button
                        size="small"
                        onClick={() => { setShowAdd(false); setNewUser(EMPTY_NEW_USER); }}
                      >
                        Cancel
                      </Button>
                    </Stack>
                  </Stack>
                </Paper>
              </Box>
            )}

            {/* The row carries two editable fields and three actions, so it has a
                floor well past a phone's width -- scroll the table, not the page. */}
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 860 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Location</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Last login</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {users.map((u) => {
                    const edit = edits[u.id] || {};
                    const name = edit.fullName ?? u.full_name;
                    const locId = edit.primaryLocationId ?? (u.primary_location_id || '');
                    const dirty = edit.fullName !== undefined
                      || edit.primaryLocationId !== undefined;
                    return (
                      <TableRow key={u.id} sx={{ opacity: u.is_active ? 1 : 0.55 }}>
                        <TableCell sx={{ minWidth: 170 }}>
                          <TextField
                            size="small" variant="standard" fullWidth value={name}
                            onChange={(e) => stage(u.id, 'fullName', e.target.value)}
                          />
                        </TableCell>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={u.role === 'ADMIN' ? 'Admin' : 'Orthodontist'}
                            color={u.role === 'ADMIN' ? 'primary' : 'default'}
                          />
                        </TableCell>
                        <TableCell sx={{ minWidth: 150 }}>
                          <TextField
                            size="small" variant="standard" select fullWidth value={locId}
                            onChange={(e) => stage(u.id, 'primaryLocationId', e.target.value)}
                          >
                            <MenuItem value="">— none —</MenuItem>
                            {locations
                              .filter((l) => l.is_active || l.id === u.primary_location_id)
                              .map((l) => (
                                <MenuItem key={l.id} value={l.id}>{l.name}</MenuItem>
                              ))}
                          </TextField>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            icon={u.is_active ? <CheckCircleIcon /> : <BlockIcon />}
                            label={u.is_active ? 'Active' : 'Inactive'}
                            color={u.is_active ? 'success' : 'default'}
                            variant={u.is_active ? 'filled' : 'outlined'}
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {fmt(u.last_login_at)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <Tooltip title={dirty ? 'Save changes' : 'No changes'}>
                              <span>
                                <IconButton
                                  size="small" disabled={!dirty}
                                  onClick={() => run(
                                    () => api.updateUser(u.id, {
                                      fullName: name,
                                      primaryLocationId: locId === '' ? undefined : locId,
                                    }),
                                    'Saved.',
                                  )}
                                >
                                  <SaveIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Reset password">
                              <IconButton
                                size="small"
                                onClick={() => setConfirm({ kind: 'password', user: u })}
                              >
                                <KeyIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={u.is_active ? 'Deactivate' : 'Reactivate'}>
                              <span>
                                <IconButton
                                  size="small"
                                  disabled={u.id === me?.id && u.is_active}
                                  onClick={() => {
                                    if (u.is_active) {
                                      setConfirm({ kind: 'deactivate', user: u });
                                    } else {
                                      run(() => api.updateUser(u.id, { isActive: true }),
                                        'User reactivated.');
                                    }
                                  }}
                                >
                                  {u.is_active
                                    ? <BlockIcon fontSize="small" />
                                    : <CheckCircleIcon fontSize="small" />}
                                </IconButton>
                              </span>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

          {/* ---------------- locations ---------------- */}
          <Paper variant="outlined">
            <Typography variant="h6" sx={{ p: 2, pb: 1 }}>Locations</Typography>
            <Box sx={{ px: 2, pb: 2 }}>
              <Stack direction="row" spacing={1}>
                <TextField
                  label="New location" size="small" sx={{ maxWidth: 320 }} fullWidth
                  placeholder="Southside Clinic"
                  value={newLocation}
                  onChange={(e) => setNewLocation(e.target.value)}
                />
                <Button
                  variant="contained" size="small" disableElevation
                  disabled={!newLocation.trim()}
                  onClick={() => run(
                    async () => { await api.createLocation(newLocation); setNewLocation(''); },
                    'Location added.',
                  )}
                >
                  Add
                </Button>
              </Stack>
            </Box>
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 420 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {locations.map((l) => (
                    <TableRow key={l.id} sx={{ opacity: l.is_active ? 1 : 0.55 }}>
                      <TableCell>{l.name}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={l.is_active ? 'Active' : 'Inactive'}
                          color={l.is_active ? 'success' : 'default'}
                          variant={l.is_active ? 'filled' : 'outlined'}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          onClick={() => run(
                            () => api.updateLocation(l.id, { isActive: !l.is_active }),
                            l.is_active ? 'Location deactivated.' : 'Location reactivated.',
                          )}
                        >
                          {l.is_active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {locations.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3}>
                        <Typography variant="body2" color="text.secondary">
                          No locations yet.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

        </Stack>
      )}

      <ConfirmDialog
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onDeactivate={(u) => run(() => api.deactivateUser(u.id), 'User deactivated.')}
        onResetPassword={(u, pw) => run(
          () => api.updateUser(u.id, { password: pw }),
          'Password reset. Share it securely.',
        )}
      />

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

/** The audit trail: who did what, newest first. Read-only by design. */
function ActivityPanel() {
  const api = useApi();
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.fetchAuditLog(150)
      .then(setAudit)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  return (
    <Box>
      {error && (
        <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined">
        <Stack
          direction="row" alignItems="center" justifyContent="space-between"
          spacing={2}
          sx={{ p: 2, pb: 1 }}
        >
          <Typography variant="h6">Activity log</Typography>
          <Button
            startIcon={<RefreshIcon />}
            size="small"
            onClick={load}
            sx={{ flexShrink: 0 }}
          >
            Refresh
          </Button>
        </Stack>
        {loading ? (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : (
          <TableContainer sx={{ maxHeight: 520, overflowX: 'auto' }}>
            <Table size="small" stickyHeader sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell>When</TableCell>
                  <TableCell>Who</TableCell>
                  <TableCell>Action</TableCell>
                  <TableCell>Target</TableCell>
                  <TableCell>Detail</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {audit.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Typography variant="caption" color="text.secondary">
                        {fmt(r.at)}
                      </Typography>
                    </TableCell>
                    <TableCell>{r.actor || '—'}</TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                        {r.action}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {r.target || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {r.detail || ''}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
                {audit.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Typography variant="body2" color="text.secondary">
                        No activity recorded yet.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
    </Box>
  );
}

function ConfirmDialog({ confirm, onClose, onDeactivate, onResetPassword }) {
  const [password, setPassword] = useState('');

  if (!confirm) return null;
  const { kind, user } = confirm;

  function close() {
    setPassword('');
    onClose();
  }

  if (kind === 'deactivate') {
    return (
      <Dialog open onClose={close}>
        <DialogTitle>Deactivate {user.full_name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            They lose access immediately. Their past prescriptions and signatures
            are preserved — the account is deactivated, never deleted.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button
            color="error" variant="contained" disableElevation
            onClick={() => { onDeactivate(user); close(); }}
          >
            Deactivate
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>Reset password for {user.full_name}</DialogTitle>
      <DialogContent>
        <TextField
          label="New temporary password"
          fullWidth
          margin="dense"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          helperText="At least 4 characters."
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained" disableElevation disabled={password.length < 4}
          onClick={() => { onResetPassword(user, password); close(); }}
        >
          Reset
        </Button>
      </DialogActions>
    </Dialog>
  );
}
