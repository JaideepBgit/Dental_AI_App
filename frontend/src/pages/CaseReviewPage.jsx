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
  Snackbar, Stack, Tab, Tabs, Tooltip, Typography, useMediaQuery,
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
import M3Viewer from '../components/M3Viewer';
import VoiceDictator from '../components/VoiceDictator';
import SignaturePicker from '../components/SignaturePicker';
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
    claim, release,
    toothDetections, segDetections, hierDetections, m3Detections,
    maskCount, hierThirdMolars, m3ThirdMolars, prescription, isApproved, isPending,
    claimedByMe, claimedBy, claimedById,
  } = useCaseDetail({ api, xrayId: id });

  const [hoveredId, setHoveredId] = useState(null);
  const [showAllBoxes, setShowAllBoxes] = useState(false);
  const [viewTab, setViewTab] = useState('detection');
  const [toast, setToast] = useState(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);
  const signatureRef = useRef(null);

  // Signing needs the review lock. An amendment on an already-signed case also
  // needs one, since signing released the previous claim.
  const needsClaim = canPrescribe && !claimedByMe;
  const heldByColleague = Boolean(claimedById) && !claimedByMe;

  // Everything that feeds a signature is inert until the lock is held. Gating
  // only the sign button would let a doctor tick teeth, dictate a note and draw a
  // signature before being refused at submit -- the whole review wasted.
  // Already-signed cases stay editable so an amendment can be prepared.
  const formLocked = saving || !canPrescribe || (needsClaim && !isApproved);

  const handleClaim = async () => {
    setLockBusy(true);
    const outcome = await claim();
    setLockBusy(false);
    setToast(outcome.ok
      ? { severity: 'success', message: 'Case claimed — it is yours to review.' }
      : { severity: 'warning', message: outcome.message });
  };

  const handleRelease = async () => {
    setLockBusy(true);
    const outcome = await release();
    setLockBusy(false);
    setToast(outcome.ok
      ? { severity: 'info', message: 'Released. The case is back in the shared queue.' }
      : { severity: 'warning', message: outcome.message });
  };

  const handleApprove = async () => {
    // Exactly one of signatureId / signature comes back, per the server contract.
    const { signatureId, signature } = signatureRef.current?.getSignature() || {};

    const outcome = await approve({ signature, signatureId });
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

  const reviewStatus = (
    <>
      {isApproved && (
        <Alert
          severity="success"
          sx={{ borderRadius: 1 }}
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
                <Typography variant="caption" sx={{ mt: 0.5, display: 'block' }}>
                  Recording an amendment. The original record is preserved.
                </Typography>
              )}
            </>
          ) : (
            <>Signed off by {caseData.referral?.doctor_name || 'the attending dentist'}.</>
          )}
        </Alert>
      )}

      {!canPrescribe && (
        <Alert severity="info" sx={{ borderRadius: 1 }}>
          Only an orthodontist can record a clinical decision. This case is read-only.
        </Alert>
      )}

      {canPrescribe && !isApproved && heldByColleague && (
        <Alert severity="warning" icon={<LockIcon fontSize="small" />} sx={{ borderRadius: 1, py: 0 }}>
          <strong>{claimedBy}</strong> holds the review lock. This case is read-only.
        </Alert>
      )}

      {canPrescribe && !isApproved && !claimedById && (
        <Alert severity="info" sx={{ borderRadius: 1, py: 0 }}>
          Unclaimed. Claim this case to record a decision.
        </Alert>
      )}

      {canPrescribe && !isApproved && claimedByMe && (
        <Alert severity="success" icon={<LockIcon fontSize="small" />} sx={{ borderRadius: 1, py: 0 }}>
          Review lock held by you.
        </Alert>
      )}
    </>
  );

  const findingsSection = (
    <FindingsList
      detections={toothDetections}
      extractionIds={extractionIds}
      onToggle={toggleExtraction}
      hoveredId={hoveredId}
      onHover={setHoveredId}
      disabled={formLocked}
    />
  );

  const decisionSection = (
    <Box>
      <Typography variant="subtitle1" sx={{ mb: 1 }}>Clinical decision</Typography>
      <RadioGroup
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          columnGap: 1,
        }}
      >
        {DECISION_OPTIONS.map((opt) => (
          <FormControlLabel
            key={opt.value}
            value={opt.value}
            disabled={formLocked}
            control={<Radio size="small" />}
            label={
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>{opt.label}</Typography>
                <Typography variant="caption" color="text.secondary">{opt.hint}</Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start', m: 0, minWidth: 0 }}
          />
        ))}
      </RadioGroup>
    </Box>
  );

  const prescriptionSection = (
    <VoiceDictator
      text={prescriptionText}
      setText={(next) => {
        setPrescriptionText(next);
        setDictationText(next);
      }}
      whisperReady
      disabled={formLocked}
      minRows={isMobile ? 3 : 10}
      maxRows={isMobile ? 8 : 12}
    />
  );

  const signatureSection = (
    <Box>
      <Typography variant="subtitle1" sx={{ mb: 1 }}>E-signature</Typography>
      <SignaturePicker ref={signatureRef} disabled={formLocked} compact={!isMobile} />
    </Box>
  );

  const actionSection = (
    <Box sx={{ pt: { xs: 2, lg: 0 }, mt: { xs: 'auto', lg: 0 }, flexShrink: 0 }}>
      {canPrescribe && !isApproved && needsClaim && (
        <Button
          variant="contained"
          color="primary"
          fullWidth
          size="large"
          startIcon={lockBusy ? <CircularProgress size={16} color="inherit" /> : <LockIcon />}
          onClick={handleClaim}
          disabled={lockBusy || loading || heldByColleague}
          disableElevation
          sx={{ py: 1.25 }}
        >
          {lockBusy ? 'Claiming…'
            : heldByColleague ? `Under review by ${claimedBy}`
              : 'Claim case to review'}
        </Button>
      )}

      {canPrescribe && (!needsClaim || isApproved) && (
        <Button
          variant="contained"
          color="primary"
          fullWidth
          size="large"
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
          onClick={handleApprove}
          disabled={saving || loading || (isApproved && !amendsId)
                    || (amendsId && needsClaim)}
          disableElevation
          sx={{ py: 1.25 }}
        >
          {saving ? 'Signing…'
            : amendsId ? 'Sign amendment'
              : isApproved ? 'Already signed'
                : 'Sign & record decision'}
        </Button>
      )}

      {canPrescribe && isApproved && amendsId && needsClaim && (
        <Button
          fullWidth
          size="small"
          startIcon={<LockIcon />}
          onClick={handleClaim}
          disabled={lockBusy || heldByColleague}
          sx={{ mt: 1 }}
        >
          {heldByColleague ? `Under review by ${claimedBy}` : 'Claim to amend'}
        </Button>
      )}

      {claimedByMe && !isApproved && (
        <Button
          fullWidth
          size="small"
          color="inherit"
          onClick={handleRelease}
          disabled={lockBusy || saving}
          sx={{ mt: 1 }}
        >
          Release without signing
        </Button>
      )}
    </Box>
  );

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
          p: { xs: 2.5, md: 2 }, display: 'flex', flexDirection: 'column', flexGrow: 1,
          minHeight: 0, overflowY: 'auto', '&:last-child': { pb: { xs: 2.5, md: 2 } },
        }}
      >
        <Stack spacing={2} sx={{ flexGrow: 1 }}>
          {reviewStatus}
          {findingsSection}
          <Divider />
          {decisionSection}
          <Divider />
          {prescriptionSection}
          {signatureSection}
        </Stack>
        <Box sx={{ pb: 'env(safe-area-inset-bottom)' }}>{actionSection}</Box>
      </CardContent>
    </Card>
  );

  const desktopReviewPanel = (
    <Card sx={{ height: '100%' }}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Stack spacing={2}>
          {reviewStatus}
          {findingsSection}
          <Divider />
          {decisionSection}
        </Stack>
      </CardContent>
    </Card>
  );

  const desktopSignoffPanel = (
    <Card>
      <CardContent
        sx={{
          p: 2,
          '&:last-child': { pb: 2 },
          display: 'grid',
          gridTemplateColumns: { md: '1fr', lg: 'minmax(0, 1.7fr) minmax(400px, 1fr)' },
          gap: 0,
          alignItems: 'stretch',
        }}
      >
        <Box sx={{ minWidth: 0, pr: { md: 0, lg: 2 } }}>
          {prescriptionSection}
        </Box>
        <Stack
          spacing={2}
          sx={{
            minWidth: 0,
            pl: { md: 0, lg: 2 }, pt: { md: 2, lg: 0 },
            borderLeft: { md: 'none', lg: '1px solid' },
            borderTop: { md: '1px solid', lg: 'none' },
            borderColor: 'divider',
          }}
        >
          {signatureSection}
          {actionSection}
        </Stack>
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
    <Container maxWidth="xl" sx={{ py: 2 }}>
      <Grid sx={{ alignItems: 'stretch' }} container spacing={{ xs: 2, lg: 2.5 }}>
        <Grid size={{ xs: 12, md: 7, lg: 8 }} sx={{ minWidth: 0, display: 'flex' }}>
          <Card sx={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
              <Stack
                direction="row"
                spacing={2}
                sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}
              >
                <Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: 'center' }}>
                  <Tooltip title="Back to review queue">
                    <IconButton component={RouterLink} to="/queue" size="small" aria-label="Back to review queue">
                      <BackIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
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
                </Stack>
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
                  mb: 1.5, minHeight: 40,
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
                <Tab
                  value="m3"
                  label={
                    <Stack sx={{ alignItems: 'center' }} direction="row" spacing={0.75}>
                      <span>Wisdom (M3)</span>
                      {m3ThirdMolars > 0 && (
                        <Chip
                          size="small"
                          label={m3ThirdMolars}
                          sx={{
                            height: 18, fontSize: '0.65rem',
                            bgcolor: '#22c55e', color: 'common.white',
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

              {viewTab === 'm3' && (
                m3Detections.length === 0 ? (
                  <Alert severity="info" sx={{ borderRadius: 2 }}>
                    The wisdom-tooth model returned no teeth for this radiograph.
                    Cases analysed before it was installed have no M3 rows —
                    re-upload the image to run it.
                  </Alert>
                ) : (
                  <>
                    <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
                      Candidate model, shown for comparison against the Detection
                      tab. It names each wisdom tooth directly, so no tooth number
                      here is a geometric estimate. Prescriptions still follow the
                      Detection tab.
                    </Alert>
                    <M3Viewer
                      imageUrl={api.xrayImageUrl(caseData.id)}
                      detections={m3Detections}
                      isAnalyzing={loading}
                      hoveredId={hoveredId}
                      onHover={setHoveredId}
                    />
                  </>
                )
              )}
            </CardContent>
          </Card>
        </Grid>

        {!isMobile && (
          <Grid
            size={{ md: 5, lg: 4 }}
            sx={{ minWidth: 0, display: 'flex' }}
          >
            {desktopReviewPanel}
          </Grid>
        )}

        {!isMobile && (
          <Grid size={12} sx={{ minWidth: 0 }}>
            {desktopSignoffPanel}
          </Grid>
        )}
      </Grid>

      {isMobile && (
        <>
          {/* Hidden while the sheet is open: at 88vh the sheet's own sign button
              lands under this one, so leaving it up puts a second, different
              action on top of the primary one. */}
          {!notesOpen && (
            <Button
              variant="contained"
              startIcon={<EditNoteIcon />}
              onClick={() => setNotesOpen(true)}
              sx={{
                position: 'fixed', right: 24, zIndex: 1000,
                // Clear the iOS home indicator, which otherwise sits over it.
                bottom: 'calc(24px + env(safe-area-inset-bottom))',
                borderRadius: 8, px: 2.5, py: 1.25,
              }}
            >
              Sign off
              {extractionIds.length > 0 && ` (${extractionIds.length})`}
            </Button>
          )}

          <Drawer
            anchor="bottom"
            open={notesOpen}
            onClose={() => setNotesOpen(false)}
            slotProps={{
              paper: {
                sx: {
                  // dvh, not vh: on mobile Safari vh is measured against the
                  // URL-bar-collapsed viewport, so the sheet's last control sits
                  // below the fold until the user scrolls the browser chrome away.
                  height: '88dvh',
                  borderTopLeftRadius: 24,
                  borderTopRightRadius: 24,
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
