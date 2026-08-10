/**
 * Patients — the Patient table finally has a UI.
 *
 * PatientsPage lists everyone on record; PatientDetailPage shows one patient's
 * radiograph history, which is what makes before/after comparison possible.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CircularProgress, Container, IconButton, Table,
  TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import BackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import { useApi } from '../services/ApiProvider';
import PageHeader from '../components/PageHeader';
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog';
import StatusChip from '../components/StatusChip';
import { formatAppointment } from '../utils/formatAppointment';

/**
 * Wording for the patient-delete dialog, shared by the list and detail views so
 * both name exactly the same consequences.
 */
function patientDeleteDescription({ name, num_xrays: count, num_approved: approved }) {
  const radiographs = `${count} radiograph${count === 1 ? '' : 's'}`;
  const referrals = approved
    ? ` and ${approved} signed referral${approved === 1 ? '' : 's'}`
    : '';
  return `This permanently removes ${name}, their ${radiographs}${referrals}, `
    + 'and every finding recorded against them. This cannot be undone.';
}

/**
 * `embedded` renders this as a panel inside the Administration tabs: the tab
 * already names the section, so a second "Patients" heading would be noise, and
 * the outer page supplies the padding. The search box moves inline above the
 * table so it is not lost with the header.
 */
export default function PatientsPage({ embedded = false }) {
  const api = useApi();
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const closeDelete = () => {
    setPendingDelete(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deletePatient(pendingDelete.mrn);
      closeDelete();
      setReloadKey((k) => k + 1);
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api.fetchPatients({ search })
        .then((data) => { if (!cancelled) { setItems(data.items || []); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, search, reloadKey]);

  const searchField = (
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
      sx={{ minWidth: 260 }}
    />
  );

  // A tab panel is already inside the admin page's container and padding.
  const Frame = embedded ? Box : Container;
  const frameProps = embedded
    ? {}
    : { maxWidth: 'lg', sx: { py: { xs: 2, md: 4 } } };

  return (
    <Frame {...frameProps}>
      {embedded ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
          {searchField}
        </Box>
      ) : (
        <PageHeader
          title="Patients"
          subtitle="Everyone with a radiograph on record."
          action={searchField}
        />
      )}

      {error && <Alert severity="error" sx={{ mb: 2.5, borderRadius: 2 }}>{error}</Alert>}

      <Card>
        {loading && items.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ px: 3, py: 8, textAlign: 'center' }}>
            <Typography variant="subtitle1" sx={{ mb: 0.5 }}>No patients yet</Typography>
            <Typography variant="body2" color="text.secondary">
              A patient record is created the first time one of their radiographs is uploaded.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 640 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>MRN</TableCell>
                  <TableCell align="right">Radiographs</TableCell>
                  <TableCell align="right">Signed off</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.mrn} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{p.name}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">{p.mrn}</Typography>
                    </TableCell>
                    <TableCell align="right">{p.num_xrays}</TableCell>
                    <TableCell align="right">{p.num_approved}</TableCell>
                    <TableCell align="right">
                      <Button size="small" component={RouterLink} to={`/patients/${p.mrn}`}>
                        History
                      </Button>
                      <Tooltip title="Delete patient and all their radiographs">
                        <IconButton
                          size="small"
                          aria-label={`Delete ${p.name}`}
                          onClick={() => setPendingDelete(p)}
                          sx={{ color: 'text.secondary', '&:hover': { color: 'impacted.main' } }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
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
        title="Delete this patient?"
        description={pendingDelete ? patientDeleteDescription(pendingDelete) : ''}
        confirmLabel="Delete patient"
        // Always gated: this is the widest destructive action in the app.
        requireMrn={pendingDelete?.mrn}
        busy={deleting}
        error={deleteError}
        onCancel={closeDelete}
        onConfirm={confirmDelete}
      />
    </Frame>
  );
}

export function PatientDetailPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { mrn } = useParams();
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchPatient(mrn)
      .then((data) => { if (!cancelled) setPatient(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [api, mrn]);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deletePatient(mrn);
      // This page's subject no longer exists; the directory is the only sane
      // landing, and it lives under Administration.
      navigate('/admin/patients', { replace: true });
    } catch (err) {
      setDeleteError(err.message);
      setDeleting(false);
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 2, md: 4 } }}>
      {/* The directory lives under Administration now, so back goes there. */}
      <Button
        component={RouterLink}
        to="/admin/patients"
        startIcon={<BackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        All patients
      </Button>

      {error ? (
        <Alert severity="error" sx={{ borderRadius: 2 }}>{error}</Alert>
      ) : !patient ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          <PageHeader
            title={patient.name}
            subtitle={`MRN ${patient.mrn}`}
            action={
              <Button
                variant="outlined"
                startIcon={<DeleteIcon />}
                onClick={() => setConfirmOpen(true)}
                sx={{ color: 'impacted.main', borderColor: 'impacted.light' }}
              >
                Delete patient
              </Button>
            }
          />

          <Card>
            {patient.xrays.length === 0 ? (
              <Box sx={{ px: 3, py: 6, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  No radiographs on record for this patient.
                </Typography>
              </Box>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 640 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Radiograph</TableCell>
                      <TableCell>Appointment</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell align="right">Teeth</TableCell>
                      <TableCell align="right">Extractions</TableCell>
                      <TableCell align="right" />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {patient.xrays.map((x) => (
                      <TableRow key={x.id} hover>
                        <TableCell>{x.filename}</TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {formatAppointment(x.appointment_date)}
                          </Typography>
                        </TableCell>
                        <TableCell><StatusChip status={x.status} /></TableCell>
                        <TableCell align="right">{x.num_detections || '—'}</TableCell>
                        <TableCell align="right">{x.marked_for_extraction || '—'}</TableCell>
                        <TableCell align="right">
                          <Button size="small" component={RouterLink} to={`/case/${x.id}`}>
                            Open
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Card>

          <ConfirmDeleteDialog
            open={confirmOpen}
            title="Delete this patient?"
            description={patientDeleteDescription({
              name: patient.name,
              num_xrays: patient.xrays.length,
              num_approved: patient.xrays.filter((x) => x.status === 'APPROVED').length,
            })}
            confirmLabel="Delete patient"
            requireMrn={patient.mrn}
            busy={deleting}
            error={deleteError}
            onCancel={() => { setConfirmOpen(false); setDeleteError(null); }}
            onConfirm={confirmDelete}
          />
        </>
      )}
    </Container>
  );
}
