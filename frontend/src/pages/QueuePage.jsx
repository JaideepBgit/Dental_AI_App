/**
 * Review Queue — every case, full width.
 *
 * The old sidebar showed only PROCESSED cases in 300px. This shows the whole
 * lifecycle, so a case being analysed or one that failed is visible and
 * actionable rather than silently absent.
 */
import {
  Alert, Box, Button, Card, Checkbox, Chip, CircularProgress, Container,
  IconButton, MenuItem, Paper, Snackbar, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import RetryIcon from '@mui/icons-material/Replay';
import NewCaseIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import LockIcon from '@mui/icons-material/LockOutlined';
import LockOpenIcon from '@mui/icons-material/LockOpenOutlined';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';

import { useApi } from '../services/ApiProvider';
import { useAuth } from '../services/AuthProvider';
import { useCases } from '../hooks/useCases';
import PageHeader from '../components/PageHeader';
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog';
import StatusChip from '../components/StatusChip';
import { formatAppointment } from '../utils/formatAppointment';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Awaiting review', value: 'PROCESSED' },
  { label: 'Processing', value: 'PENDING' },
  { label: 'Signed off', value: 'APPROVED' },
  { label: 'Failed', value: 'ERROR' },
];

export default function QueuePage() {
  const api = useApi();
  const { isAdmin, isOrthodontist } = useAuth();
  const {
    items, loading, error, status, setStatus, search, setSearch, refresh, retry, remove,
    assigned, setAssigned,
  } = useCases({ api });

  // Review locks. `lockBusyId` disables just the row being claimed or released,
  // so the rest of the table stays usable while one request is in flight.
  const [lockBusyId, setLockBusyId] = useState(null);
  const [lockError, setLockError] = useState(null);

  /** Claim a case for review, or release it back to the shared queue. */
  async function toggleLock(item, action) {
    setLockError(null);
    setLockBusyId(item.id);
    try {
      if (action === 'claim') {
        await api.claimXray(item.id);
        setAssignToast(`${item.patient_name} is now under your review.`);
      } else {
        await api.releaseXray(item.id);
        setAssignToast(`${item.patient_name} returned to the shared queue.`);
      }
      await refresh();
    } catch (err) {
      setLockError(err.message);
      // A lost race leaves the row stale, so pull fresh state either way.
      await refresh();
    } finally {
      setLockBusyId(null);
    }
  }

  // The case the delete dialog is currently asking about, if any.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Assignment is an admin action, so the doctor list is only fetched for them.
  const [doctors, setDoctors] = useState([]);
  const [assignError, setAssignError] = useState(null);
  const [assignToast, setAssignToast] = useState('');
  const [savingId, setSavingId] = useState(null);

  // Staged owner per row: picking a doctor does NOT write. The change is held
  // here until Save, so a misclick cannot reassign a case, and the row shows
  // clearly that there is something unsaved.
  const [staged, setStaged] = useState({});

  // Bulk selection, for routing a batch to one doctor in a single action.
  const [selected, setSelected] = useState([]);
  const [bulkDoctor, setBulkDoctor] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    api.fetchUsers()
      .then((users) => {
        if (cancelled) return;
        setDoctors(users.filter((u) => u.role === 'ORTHODONTIST' && u.is_active));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, isAdmin]);

  /** Current owner shown for a row: the staged value if any, else what is stored. */
  function ownerValue(item) {
    const stagedValue = staged[item.id];
    if (stagedValue !== undefined) return stagedValue;
    return item.assigned_to_id ? String(item.assigned_to_id) : '';
  }

  function isDirty(item) {
    const stagedValue = staged[item.id];
    if (stagedValue === undefined) return false;
    const stored = item.assigned_to_id ? String(item.assigned_to_id) : '';
    return stagedValue !== stored;
  }

  function stageOwner(xrayId, userId) {
    setStaged((prev) => ({ ...prev, [xrayId]: userId }));
  }

  function discardRow(xrayId) {
    setStaged((prev) => {
      const next = { ...prev };
      delete next[xrayId];
      return next;
    });
  }

  function nameFor(userId) {
    if (!userId) return null;
    return doctors.find((d) => String(d.id) === String(userId))?.full_name || null;
  }

  /** Commit one row's staged owner. */
  async function saveRow(item) {
    const value = ownerValue(item);
    setAssignError(null);
    setSavingId(item.id);
    try {
      // '' means unassign; the API takes undefined for that.
      await api.assignXray(item.id, value === '' ? undefined : value);
      discardRow(item.id);
      const who = nameFor(value);
      setAssignToast(who
        ? `${item.patient_name} assigned to ${who}.`
        : `${item.patient_name} returned to the unassigned pool.`);
      await refresh();
    } catch (err) {
      setAssignError(err.message);
    } finally {
      setSavingId(null);
    }
  }

  /** Commit the bulk bar: every selected case to one doctor (or unassigned). */
  async function saveBulk() {
    setAssignError(null);
    setBulkBusy(true);
    try {
      await api.assignXraysBulk(selected, bulkDoctor === '' ? undefined : bulkDoctor);
      const who = nameFor(bulkDoctor);
      setAssignToast(who
        ? `${selected.length} case(s) assigned to ${who}.`
        : `${selected.length} case(s) returned to the unassigned pool.`);
      // Clear staged edits for the rows the bulk action just overwrote, or the
      // table would still show them as dirty against the new stored value.
      setStaged((prev) => {
        const next = { ...prev };
        selected.forEach((id) => delete next[id]);
        return next;
      });
      setSelected([]);
      setBulkDoctor('');
      await refresh();
    } catch (err) {
      setAssignError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleSelected(xrayId) {
    setSelected((prev) =>
      (prev.includes(xrayId) ? prev.filter((i) => i !== xrayId) : [...prev, xrayId]));
  }

  const allSelected = items.length > 0 && selected.length === items.length;
  const dirtyCount = items.filter(isDirty).length;

  // Changing a filter reloads a different set of rows, so staged edits and ticks
  // for rows that are no longer on screen must not linger -- they would show a
  // stale "unsaved changes" count and could bulk-assign an invisible case.
  useEffect(() => {
    setStaged({});
    setSelected([]);
  }, [status, assigned, search]);

  const closeDelete = () => {
    setPendingDelete(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    const outcome = await remove(pendingDelete.id);
    setDeleting(false);
    if (outcome.ok) {
      closeDelete();
    } else {
      setDeleteError(outcome.message);
    }
  };

  // The dashboard tiles link in with ?status=..., so honour it on arrival.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const fromUrl = searchParams.get('status');
    if (fromUrl) setStatus(fromUrl);
  }, [searchParams, setStatus]);

  const isFiltered = Boolean(status) || Boolean(search.trim());

  return (
    <Container maxWidth="xl" sx={{ py: { xs: 2, md: 4 } }}>
      <PageHeader
        title="Review Queue"
        subtitle={isAdmin
          ? "Every case in the practice. Doctors claim their own; assign one only when it must go to a specific orthodontist."
          : "The shared queue, soonest appointment first. Claim a case to review it."}
        action={
          <Stack direction="row" spacing={1}>
            {/* Intake is an admin action; a doctor works what they are given. */}
            {isAdmin && (
              <Button
                variant="contained"
                component={RouterLink}
                to="/upload"
                startIcon={<NewCaseIcon />}
                disableElevation
              >
                New Case
              </Button>
            )}
            <Tooltip title="Refresh">
              <IconButton onClick={refresh} disabled={loading}>
                {loading ? <CircularProgress size={18} /> : <RefreshIcon />}
              </IconButton>
            </Tooltip>
          </Stack>
        }
      />

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { md: 'center' }, mb: 2.5 }}
      >
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', flexGrow: 1 }}>
          {FILTERS.map((filter) => (
            <Button
              key={filter.value || 'all'}
              size="small"
              onClick={() => setStatus(filter.value)}
              variant={status === filter.value ? 'contained' : 'outlined'}
              disableElevation
            >
              {filter.label}
            </Button>
          ))}
        </Stack>

        {isAdmin && (
          <TextField
            size="small"
            select
            label="Assigned to"
            value={assigned}
            onChange={(e) => setAssigned(e.target.value)}
            sx={{ minWidth: { md: 190 } }}
          >
            <MenuItem value="">Anyone</MenuItem>
            <MenuItem value="unassigned">Unassigned</MenuItem>
            {doctors.map((d) => (
              <MenuItem key={d.id} value={String(d.id)}>{d.full_name}</MenuItem>
            ))}
          </TextField>
        )}

        <TextField
          size="small"
          placeholder="Search name or MRN"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />,
            },
          }}
          sx={{ minWidth: { md: 280 } }}
        />
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2.5, borderRadius: 2 }}>{error}</Alert>
      )}
      {assignError && (
        <Alert severity="error" sx={{ mb: 2.5, borderRadius: 2 }}
               onClose={() => setAssignError(null)}>
          {assignError}
        </Alert>
      )}
      {lockError && (
        <Alert severity="warning" sx={{ mb: 2.5, borderRadius: 2 }}
               onClose={() => setLockError(null)}>
          {lockError}
        </Alert>
      )}

      {/* Bulk bar: appears only once rows are ticked, so it never takes up space
          during ordinary browsing. */}
      {isAdmin && selected.length > 0 && (
        <Paper
          variant="outlined"
          sx={{
            mb: 2.5, p: 1.5, borderRadius: 2,
            display: 'flex', flexWrap: 'wrap', gap: 1.5,
            alignItems: 'center', bgcolor: 'action.hover',
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {selected.length} selected
          </Typography>
          <TextField
            size="small"
            select
            label="Assign to"
            value={bulkDoctor}
            onChange={(e) => setBulkDoctor(e.target.value)}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="">Unassigned</MenuItem>
            {doctors.map((d) => (
              <MenuItem key={d.id} value={String(d.id)}>{d.full_name}</MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            size="small"
            disableElevation
            onClick={saveBulk}
            disabled={bulkBusy}
            startIcon={bulkBusy ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
          >
            {bulkBusy ? 'Assigning…' : 'Assign'}
          </Button>
          <Button size="small" onClick={() => { setSelected([]); setBulkDoctor(''); }}>
            Clear selection
          </Button>
        </Paper>
      )}

      {isAdmin && dirtyCount > 0 && (
        <Alert severity="info" sx={{ mb: 2.5, borderRadius: 2 }}>
          {dirtyCount} unsaved assignment change{dirtyCount > 1 ? 's' : ''} — click the
          save icon on each row to store it.
        </Alert>
      )}

      <Card>
        {items.length === 0 && !loading ? (
          <Box sx={{ px: 3, py: 8, textAlign: 'center' }}>
            <Typography variant="subtitle1" sx={{ mb: 0.5 }}>
              {isFiltered ? 'No cases match this filter'
                : isAdmin ? 'No cases yet' : 'No cases waiting'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {isFiltered
                ? 'Try a different status or clear the search.'
                : isAdmin
                  ? 'Radiographs dropped into the inbox folder appear here automatically.'
                  : 'The shared queue is clear. New cases appear here for any doctor to claim.'}
            </Typography>
            {isFiltered ? (
              <Button
                variant="outlined"
                onClick={() => { setStatus(''); setSearch(''); setAssigned(''); }}
              >
                Clear filters
              </Button>
            ) : isAdmin && (
              <Button variant="contained" component={RouterLink} to="/upload" disableElevation>
                Upload the first case
              </Button>
            )}
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 800 }}>
              <TableHead>
                <TableRow>
                  {isAdmin && (
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={allSelected}
                        indeterminate={selected.length > 0 && !allSelected}
                        onChange={() => setSelected(
                          allSelected ? [] : items.map((i) => i.id),
                        )}
                        slotProps={{ input: { 'aria-label': 'Select all cases' } }}
                      />
                    </TableCell>
                  )}
                  <TableCell>Patient</TableCell>
                  <TableCell>MRN</TableCell>
                  <TableCell>Appointment</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Review</TableCell>
                  {isAdmin && <TableCell>Assigned to</TableCell>}
                  <TableCell align="right">Teeth</TableCell>
                  <TableCell>Findings</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    hover
                    selected={selected.includes(item.id)}
                    // Tint an unsaved row so it is obvious the change is not stored.
                    sx={isDirty(item) ? { bgcolor: 'rgba(234, 179, 8, 0.09)' } : undefined}
                  >
                    {isAdmin && (
                      <TableCell padding="checkbox">
                        <Checkbox
                          size="small"
                          checked={selected.includes(item.id)}
                          onChange={() => toggleSelected(item.id)}
                          slotProps={{
                            input: { 'aria-label': `Select case for ${item.patient_name}` },
                          }}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <Box
                        component={RouterLink}
                        to={`/case/${item.id}`}
                        sx={{
                          color: 'text.primary', textDecoration: 'none',
                          fontWeight: 600, '&:hover': { color: 'primary.main' },
                        }}
                      >
                        {item.patient_name}
                      </Box>
                      <Typography variant="caption" color="text.secondary" display="block">
                        {item.filename}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">{item.mrn}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatAppointment(item.appointment_date)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={item.status} title={item.error_message} />
                    </TableCell>
                    {/* Who holds the review lock. On a shared queue this is what
                        tells a doctor whether a case is theirs to pick up. */}
                    <TableCell sx={{ minWidth: 150 }}>
                      {item.status === 'APPROVED' ? (
                        <Typography variant="caption" color="text.secondary">—</Typography>
                      ) : item.claimed_by_me ? (
                        <Chip
                          size="small"
                          icon={<LockIcon sx={{ fontSize: 14 }} />}
                          label="You"
                          color="primary"
                          sx={{ height: 22, fontSize: '0.7rem' }}
                        />
                      ) : item.claimed_by ? (
                        <Tooltip title={`Under review by ${item.claimed_by}`}>
                          <Chip
                            size="small"
                            icon={<LockIcon sx={{ fontSize: 14 }} />}
                            label={item.claimed_by}
                            sx={{
                              height: 22, fontSize: '0.7rem', maxWidth: 140,
                              bgcolor: 'caries.light', color: '#92400e',
                            }}
                          />
                        </Tooltip>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          Unclaimed
                        </Typography>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell sx={{ minWidth: 240 }}>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                          {/* Picking a doctor only stages the change; nothing is
                              written until the save icon is clicked. */}
                          <TextField
                            size="small"
                            select
                            variant="standard"
                            sx={{ flexGrow: 1, minWidth: 140 }}
                            value={ownerValue(item)}
                            onChange={(e) => stageOwner(item.id, e.target.value)}
                            slotProps={{ select: { displayEmpty: true } }}
                          >
                            <MenuItem value="">
                              <Typography variant="body2" color="warning.main">
                                Unassigned
                              </Typography>
                            </MenuItem>
                            {doctors.map((d) => (
                              <MenuItem key={d.id} value={String(d.id)}>{d.full_name}</MenuItem>
                            ))}
                            {/* A case held by a now-inactive doctor still needs to
                                render its current owner, or the select shows blank. */}
                            {item.assigned_to_id
                              && !doctors.some((d) => d.id === item.assigned_to_id) && (
                              <MenuItem value={String(item.assigned_to_id)}>
                                {item.assigned_to} (inactive)
                              </MenuItem>
                            )}
                          </TextField>

                          {isDirty(item) && (
                            <>
                              <Tooltip title="Save assignment">
                                <span>
                                  <IconButton
                                    size="small"
                                    color="primary"
                                    onClick={() => saveRow(item)}
                                    disabled={savingId === item.id}
                                    aria-label={`Save assignment for ${item.patient_name}`}
                                  >
                                    {savingId === item.id
                                      ? <CircularProgress size={16} />
                                      : <SaveIcon fontSize="small" />}
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title="Discard change">
                                <IconButton
                                  size="small"
                                  onClick={() => discardRow(item.id)}
                                  disabled={savingId === item.id}
                                  aria-label={`Discard assignment change for ${item.patient_name}`}
                                >
                                  <CloseIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </>
                          )}
                        </Stack>
                      </TableCell>
                    )}
                    <TableCell align="right">
                      <Typography variant="body2">{item.num_detections || '—'}</Typography>
                    </TableCell>
                    <TableCell>
                      <Stack sx={{ flexWrap: 'wrap' }} direction="row" spacing={0.5} useFlexGap>
                        {item.num_third_molars > 0 && (
                          <Chip
                            size="small"
                            label={`${item.num_third_molars} 3rd molar${item.num_third_molars > 1 ? 's' : ''}`}
                            sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'caries.light', color: '#92400e' }}
                          />
                        )}
                        {item.marked_for_extraction > 0 && (
                          <Chip
                            size="small"
                            label={`${item.marked_for_extraction} extraction`}
                            sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'impacted.light', color: '#991b1b' }}
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Stack sx={{ justifyContent: 'flex-end' }} direction="row" spacing={0.5}>
                        {item.status === 'ERROR' && (
                          <Button
                            size="small"
                            startIcon={<RetryIcon fontSize="small" />}
                            onClick={() => retry(item.id)}
                          >
                            Retry
                          </Button>
                        )}

                        {/* Claim / release, straight from the queue so a doctor can
                            pick up work without opening each case first.
                            `blocked_reason` is computed server-side. */}
                        {isOrthodontist && item.status !== 'APPROVED' && (
                          item.claimed_by_me ? (
                            <Tooltip title="Return this case to the shared queue">
                              <span>
                                <Button
                                  size="small"
                                  color="inherit"
                                  startIcon={lockBusyId === item.id
                                    ? <CircularProgress size={13} />
                                    : <LockOpenIcon fontSize="small" />}
                                  onClick={() => toggleLock(item, 'release')}
                                  disabled={lockBusyId === item.id}
                                >
                                  Release
                                </Button>
                              </span>
                            </Tooltip>
                          ) : (
                            <Tooltip title={item.blocked_reason || 'Claim this case to review it'}>
                              <span>
                                <Button
                                  size="small"
                                  startIcon={lockBusyId === item.id
                                    ? <CircularProgress size={13} />
                                    : <LockIcon fontSize="small" />}
                                  onClick={() => toggleLock(item, 'claim')}
                                  disabled={lockBusyId === item.id || Boolean(item.blocked_reason)}
                                >
                                  Claim
                                </Button>
                              </span>
                            </Tooltip>
                          )
                        )}

                        {/* Admin force-release: claims never expire, so somebody
                            has to be able to free a case left held off-shift. */}
                        {isAdmin && item.claimed_by && item.status !== 'APPROVED' && (
                          <Tooltip title={`Force-release from ${item.claimed_by}`}>
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => toggleLock(item, 'release')}
                                disabled={lockBusyId === item.id}
                                aria-label={`Force-release case for ${item.patient_name}`}
                                sx={{ color: 'text.secondary' }}
                              >
                                {lockBusyId === item.id
                                  ? <CircularProgress size={14} />
                                  : <LockOpenIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}

                        {/* "Review" is promised only when the case can actually be
                            reviewed: signed off, or held by this doctor. Unclaimed
                            or colleague-held cases open read-only, so they say
                            "Open" -- labelling those "Review" sends the doctor to a
                            panel that cannot sign, or to a 403. */}
                        <Button size="small" component={RouterLink} to={`/case/${item.id}`}>
                          {item.status === 'APPROVED' ? 'View'
                            : (item.claimed_by_me || !isOrthodontist) ? 'Review'
                              : 'Open'}
                        </Button>
                        {/* Deleting a case destroys a radiograph and possibly a
                            signed referral -- admin only, matching the backend. */}
                        {isAdmin && (
                          <Tooltip title="Delete case">
                            <IconButton
                              size="small"
                              aria-label={`Delete case for ${item.patient_name}`}
                              onClick={() => setPendingDelete(item)}
                              sx={{ color: 'text.secondary', '&:hover': { color: 'impacted.main' } }}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>

      <ConfirmDeleteDialog
        open={Boolean(pendingDelete)}
        title="Delete this case?"
        description={
          pendingDelete?.status === 'APPROVED'
            ? `This destroys a signed referral for ${pendingDelete?.patient_name}, along with the radiograph, its findings and the referral PDF. This cannot be undone.`
            : `This permanently removes the radiograph for ${pendingDelete?.patient_name}, along with its findings. This cannot be undone. The patient record is kept.`
        }
        confirmLabel="Delete case"
        // A signed referral is a clinical record: make it deliberate.
        requireMrn={pendingDelete?.status === 'APPROVED' ? pendingDelete?.mrn : null}
        busy={deleting}
        error={deleteError}
        onCancel={closeDelete}
        onConfirm={confirmDelete}
      />

      <Snackbar
        open={Boolean(assignToast)}
        autoHideDuration={4000}
        onClose={() => setAssignToast('')}
        message={assignToast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Container>
  );
}
