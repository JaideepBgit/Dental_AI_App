/**
 * Case Review — the dentist's core loop, now on its own route.
 *
 * Same two-panel layout as before (viewer left, sign-off right): it is the
 * screen a dentist spends the day in and splitting it across pages would make
 * that slower, not clearer. What changed is that the case id comes from the URL
 * so a case is linkable, and all data and validation live in useCaseDetail.
 */
import { useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Container,
  Divider, Drawer, FormControlLabel, Grid, IconButton, Radio, RadioGroup,
  Snackbar, Stack, Tab, Tabs, Typography, useMediaQuery,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import EditNoteIcon from '@mui/icons-material/EditNote';
import EditIcon from '@mui/icons-material/Edit';
import CloseIcon from '@mui/icons-material/Close';
import PdfIcon from '@mui/icons-material/PictureAsPdf';
import BackIcon from '@mui/icons-material/ArrowBack';
import RetryIcon from '@mui/icons-material/Replay';
import LockIcon from '@mui/icons-material/LockOutlined';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import ErrorIcon from '@mui/icons-material/Error';
import { Link as RouterLink, useParams } from 'react-router-dom';

import theme from '../theme';
import Viewer, { ViewerLegend } from '../components/Viewer';
import SegmentationViewer from '../components/SegmentationViewer';
import DentitionViewer from '../components/DentitionViewer';
import VoiceDictator from '../components/VoiceDictator';
import SignaturePad from '../components/SignaturePad';
import FindingsList from '../components/FindingsList';
import StatusChip from '../components/StatusChip';
import { useApi } from '../services/ApiProvider';
import { useAuth } from '../services/AuthProvider';
import { useCaseDetail } from '../hooks/useCaseDetail';
import { formatAppointment } from '../utils/formatAppointment';

/** The four decisions a clinician can record. Mirrors DECISIONS in db.py. */
const DECISION_OPTIONS = [
  { value: 'EXTRACT', label: 'Extraction', hint: 'Recommend removal' },
  { value: 'REFER', label: 'Refer', hint: 'Send to oral surgery' },
  { value: 'MONITOR', label: 'Monitor', hint: 'Review at next recall' },
  { value: 'NO_ACTION_NEEDED', label: 'No action needed', hint: 'Nothing required' },
];

export const DECISION_LABELS = DECISION_OPTIONS.reduce(
  (acc, o) => ({ ...acc, [o.value]: o.label }), {},
);

function fmtStamp(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+$/, '').slice(0, 16);
}

export default function CaseReviewPage() {
  const api = useApi();
  const { id } = useParams();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const { isOrthodontist: canPrescribe } = useAuth();

  const {
    caseData, loading, error, errorStatus, saving,
    extractionIds, toggleExtraction,
    prescriptionText, setPrescriptionText,
    decision, setDecision,
    setDictationText,
    amendsId, startAmendment,
    approve, reload,
    toothDetections, segDetections, hierDetections,
    maskCount, hierThirdMolars, prescription, isApproved, isPending,
  } = useCaseDetail({ api, xrayId: id });

  const [hoveredId, setHoveredId] = useState(null);
  const [showAllBoxes, setShowAllBoxes] = useState(false);
  const [viewTab, setViewTab] = useState('detection');
  const [toast, setToast] = useState(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const signatureRef = useRef(null);

  const handleApprove = async () => {
    const signature = signatureRef.current && !signatureRef.current.isEmpty()
      ? signatureRef.current.toDataURL()
      : '';

    const outcome = await approve({ signature });
    if (!outcome.ok) {
      setToast({ severity: 'warning', message: outcome.message });
      return;
    }
    const { result } = outcome;
    setToast({
      severity: 'success',
      message: result.pdf_url
        ? `Signed: ${DECISION_LABELS[result.decision] || result.decision} `
          + `(${result.marked_for_extraction} marked for extraction).`
        : `Signed: ${DECISION_LABELS[result.decision] || result.decision}. No referral generated.`,
    });
    signatureRef.current?.clear();
    if (isMobile) setNotesOpen(false);
  };

  const handleRetry = async () => {
    try {
      await api.retryXray(caseData.id);
      setToast({ severity: 'info', message: 'Re-running detection…' });
      // Give the background task a moment before reloading.
      setTimeout(reload, 2000);
    } catch (err) {
      setToast({ severity: 'error', message: err.message });
    }
  };

  const notesPanel = (
    <Card
      sx={{
        height: '100%', display: 'flex', flexDirection: 'column',
        ...(isMobile && { borderRadius: '24px 24px 0 0', border: 'none' }),
      }}
    >
      {isMobile && (
        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'center', px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}
        >
          <Typography variant="h6">Sign-off</Typography>
          <IconButton onClick={() => setNotesOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </Stack>
      )}

      <CardContent
        sx={{
          p: 3, display: 'flex', flexDirection: 'column', flexGrow: 1,
          minHeight: 0, overflowY: 'auto', '&:last-child': { pb: 3 },
        }}
      >
        <Stack spacing={3} sx={{ flexGrow: 1 }}>
          {isApproved && (
            <Alert
              severity="success"
              sx={{ borderRadius: 2 }}
              action={
                <Button
                  size="small"
                  startIcon={<PdfIcon />}
                  href={api.referralUrl(caseData.id)}
                  target="_blank"
                  rel="noopener"
                >
                  PDF
                </Button>
              }
            >
              {prescription ? (
                <>
                  <strong>{DECISION_LABELS[prescription.decision] || prescription.decision}</strong>
                  {' — signed by '}{prescription.clinician}
                  {prescription.location ? ` (${prescription.location})` : ''}
                  {' on '}{fmtStamp(prescription.signed_at)}.
                  {!amendsId && canPrescribe && (
                    <Box sx={{ mt: 1 }}>
                      <Button size="small" startIcon={<EditIcon />} onClick={startAmendment}>
                        Record an amendment
                      </Button>
                    </Box>
                  )}
                  {amendsId && (
                    <Box sx={{ mt: 0.5 }}>
                      <Typography variant="caption">
                        Recording an amendment. The original record is preserved.
                      </Typography>
                    </Box>
                  )}
                </>
              ) : (
                <>
                  Signed off by {caseData.referral?.doctor_name || 'the attending dentist'}.
                </>
              )}
            </Alert>
          )}

          {!canPrescribe && (
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              Only an orthodontist can record a clinical decision. You have
              read-only access to this case.
            </Alert>
          )}

          <FindingsList
            detections={toothDetections}
            extractionIds={extractionIds}
            onToggle={toggleExtraction}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            disabled={saving}
          />

          <Divider />

          <Box>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>Clinical decision</Typography>
            <RadioGroup
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              {DECISION_OPTIONS.map((opt) => (
                <FormControlLabel
                  key={opt.value}
                  value={opt.value}
                  disabled={saving || !canPrescribe}
                  control={<Radio size="small" />}
                  label={
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {opt.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {opt.hint}
                      </Typography>
                    </Box>
                  }
                  sx={{ alignItems: 'flex-start', mb: 0.5 }}
                />
              ))}
            </RadioGroup>
          </Box>

          <Divider />

          <VoiceDictator
            text={prescriptionText}
            setText={(next) => {
              setPrescriptionText(next);
              // VoiceDictator replaces the whole value on transcription; capture
              // what it produced so the raw dictation is stored alongside the
              // possibly-edited note.
              setDictationText(next);
            }}
            whisperReady
            disabled={saving || !canPrescribe}
          />

          <Box>
            <Stack
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.5, minHeight: 32 }}
            >
              <Typography variant="subtitle1">E-signature</Typography>
              <Button
                size="small"
                onClick={() => signatureRef.current?.clear()}
                color="inherit"
                disabled={saving}
              >
                Clear
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Sign to authorise this decision. Your name, location and the
              signing time are recorded from your account.
            </Typography>
            <Box
              sx={{
                border: '1px solid', borderColor: 'divider', borderRadius: 2,
                bgcolor: '#f9fafb', overflow: 'hidden',
              }}
            >
              <SignaturePad ref={signatureRef} />
            </Box>
          </Box>
        </Stack>

        <Box sx={{ pt: 3, mt: 'auto', flexShrink: 0 }}>
          <Button
            variant="contained"
            color="primary"
            fullWidth
            size="large"
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            onClick={handleApprove}
            disabled={saving || loading || !canPrescribe || (isApproved && !amendsId)}
            disableElevation
            sx={{ py: 1.25 }}
          >
            {saving ? 'Signing…'
              : amendsId ? 'Sign amendment'
                : isApproved ? 'Already signed'
                  : 'Sign & record decision'}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );

  if (loading && !caseData) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 12 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    // A 403 means the case exists but is not this doctor's to work, and a 404
    // that the id is wrong. Neither is a fault the user can fix by retrying, so
    // both get a plain explanation rather than a red error banner.
    const notMine = errorStatus === 403;
    const missing = errorStatus === 404;
    const expected = notMine || missing;

    return (
      <Container maxWidth="sm" sx={{ py: { xs: 6, md: 10 } }}>
        <Stack spacing={2.5} sx={{ alignItems: 'center', textAlign: 'center' }}>
          <Box
            sx={{
              width: 56, height: 56, borderRadius: '50%',
              display: 'grid', placeItems: 'center',
              bgcolor: expected ? 'action.hover' : 'error.light',
              color: expected ? 'text.secondary' : 'error.main',
            }}
          >
            {notMine ? <LockIcon /> : missing ? <SearchOffIcon /> : <ErrorIcon />}
          </Box>

          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {notMine ? 'Not your case'
              : missing ? 'Case not found'
                : 'Could not load this case'}
          </Typography>

          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
            {expected ? error : `${error} Please try again, or contact an administrator if it persists.`}
          </Typography>

          <Stack direction="row" spacing={1}>
            <Button
              component={RouterLink}
              to="/queue"
              variant="contained"
              disableElevation
              startIcon={<BackIcon />}
            >
              Back to queue
            </Button>
            {/* Retrying only makes sense for a transient failure. */}
            {!expected && (
              <Button onClick={reload} startIcon={<RetryIcon />}>
                Try again
              </Button>
            )}
          </Stack>
        </Stack>
      </Container>
    );
  }

  if (!caseData) return null;

  return (
    <Container maxWidth="xl" sx={{ py: { xs: 2, md: 3 } }}>
      <Button
        component={RouterLink}
        to="/queue"
        startIcon={<BackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        Review queue
      </Button>

      <Grid sx={{ alignItems: 'flex-start' }} container spacing={3}>
        <Grid size={{ xs: 12, md: 7, lg: 8 }} sx={{ minWidth: 0 }}>
          <Card sx={{ display: 'flex', flexDirection: 'column' }}>
            <CardContent sx={{ p: { xs: 2, md: 3 }, '&:last-child': { pb: { xs: 2, md: 3 } } }}>
              <Stack
                direction="row"
                spacing={2}
                sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.25 }}>
                    <Typography variant="h6" noWrap title={caseData.patient_name}>
                      {caseData.patient_name}
                    </Typography>
                    <StatusChip status={caseData.status} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    <Box
                      component={RouterLink}
                      to={`/patients/${caseData.mrn}`}
                      sx={{ color: 'inherit', textDecoration: 'none', '&:hover': { color: 'primary.main' } }}
                    >
                      {caseData.mrn}
                    </Box>
                    {' · '}{caseData.filename}
                    {caseData.appointment_date
                      ? ` · ${formatAppointment(caseData.appointment_date)}`
                      : ''}
                  </Typography>
                </Box>
                {viewTab === 'detection' && toothDetections.length > 0 && (
                  <Button
                    size="small"
                    variant="text"
                    color="inherit"
                    onClick={() => setShowAllBoxes((v) => !v)}
                    sx={{ flexShrink: 0 }}
                  >
                    {showAllBoxes ? 'Show 3rd molars' : `Show all ${toothDetections.length}`}
                  </Button>
                )}
              </Stack>

              {isPending && (
                <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
                  This radiograph is still being analysed. Refresh in a moment.
                </Alert>
              )}

              {caseData.status === 'ERROR' && (
                <Alert
                  severity="error"
                  sx={{ mb: 2, borderRadius: 2 }}
                  action={
                    <Button size="small" startIcon={<RetryIcon />} onClick={handleRetry}>
                      Retry
                    </Button>
                  }
                >
                  Detection failed for this case: {caseData.error_message}
                </Alert>
              )}

              <Tabs
                value={viewTab}
                onChange={(_, v) => { setViewTab(v); setHoveredId(null); }}
                sx={{
                  mb: 2, minHeight: 40,
                  borderBottom: '1px solid', borderColor: 'divider',
                  '& .MuiTab-root': { minHeight: 40, py: 0 },
                }}
              >
                <Tab value="detection" label="Detection" />
                <Tab
                  value="segmentation"
                  label={
                    <Stack sx={{ alignItems: 'center' }} direction="row" spacing={0.75}>
                      <span>Segmentation</span>
                      {maskCount > 0 && (
                        <Chip
                          size="small"
                          label={maskCount}
                          sx={{
                            height: 18, fontSize: '0.65rem',
                            bgcolor: 'primary.main', color: 'common.white',
                            '& .MuiChip-label': { px: 0.6 },
                          }}
                        />
                      )}
                    </Stack>
                  }
                />
                <Tab
                  value="dentition"
                  label={
                    <Stack sx={{ alignItems: 'center' }} direction="row" spacing={0.75}>
                      <span>Dentition</span>
                      {hierThirdMolars > 0 && (
                        <Chip
                          size="small"
                          label={hierThirdMolars}
                          sx={{
                            height: 18, fontSize: '0.65rem',
                            bgcolor: '#f59e0b', color: 'common.white',
                            '& .MuiChip-label': { px: 0.6 },
                          }}
                        />
                      )}
                    </Stack>
                  }
                />
              </Tabs>

              {viewTab === 'detection' && (
                <>
                  <Viewer
                    imageUrl={api.xrayImageUrl(caseData.id)}
                    detections={toothDetections}
                    extractionIds={extractionIds}
                    isAnalyzing={loading}
                    hoveredId={hoveredId}
                    onHover={setHoveredId}
                    showAll={showAllBoxes}
                  />
                  <Box sx={{ mt: 1.5 }}><ViewerLegend /></Box>
                </>
              )}

              {viewTab === 'segmentation' && (
                segDetections.length === 0 ? (
                  <Alert severity="info" sx={{ borderRadius: 2 }}>
                    The segmentation model returned no findings for this radiograph.
                    Cases analysed before it was installed have no masks — re-upload
                    the image to segment it.
                  </Alert>
                ) : (
                  <>
                    {maskCount === 0 && (
                      <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
                        This case has no stored masks — it was analysed by a
                        detection-only model. Outlines below are bounding boxes.
                      </Alert>
                    )}
                    <SegmentationViewer
                      imageUrl={api.xrayImageUrl(caseData.id)}
                      detections={segDetections}
                      isAnalyzing={loading}
                      hoveredId={hoveredId}
                      onHover={setHoveredId}
                    />
                  </>
                )
              )}

              {viewTab === 'dentition' && (
                hierDetections.length === 0 ? (
                  <Alert severity="info" sx={{ borderRadius: 2 }}>
                    The full-dentition model returned no teeth for this radiograph.
                  </Alert>
                ) : (
                  <DentitionViewer
                    imageUrl={api.xrayImageUrl(caseData.id)}
                    detections={hierDetections}
                    isAnalyzing={loading}
                    hoveredId={hoveredId}
                    onHover={setHoveredId}
                  />
                )
              )}
            </CardContent>
          </Card>
        </Grid>

        {!isMobile && (
          <Grid
            size={{ md: 5, lg: 4 }}
            sx={{
              position: 'sticky', top: 88,
              maxHeight: 'calc(100vh - 112px)', display: 'flex', minWidth: 0,
            }}
          >
            {notesPanel}
          </Grid>
        )}
      </Grid>

      {isMobile && (
        <>
          <Button
            variant="contained"
            startIcon={<EditNoteIcon />}
            onClick={() => setNotesOpen(true)}
            sx={{
              position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
              borderRadius: 8, px: 2.5, py: 1.25,
            }}
          >
            Sign off
            {extractionIds.length > 0 && ` (${extractionIds.length})`}
          </Button>

          <Drawer
            anchor="bottom"
            open={notesOpen}
            onClose={() => setNotesOpen(false)}
            slotProps={{
              paper: {
                sx: {
                  height: '88vh', borderTopLeftRadius: 24, borderTopRightRadius: 24,
                  bgcolor: 'background.default',
                },
              },
            }}
          >
            {notesPanel}
          </Drawer>
        </>
      )}

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)} sx={{ borderRadius: 2 }}>
            {toast.message}
          </Alert>
        ) : null}
      </Snackbar>
    </Container>
  );
}
