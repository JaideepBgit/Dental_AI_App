/**
 * New Case — the intake flow.
 *
 * Three steps: choose an image, say who it belongs to, then submit. Detection
 * runs in the background, so the page reports progress rather than freezing on
 * a spinner while three models run.
 */
import { useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, Container, Grid,
  LinearProgress, Stack, Step, StepLabel, Stepper, TextField, Typography,
} from '@mui/material';
import UploadIcon from '@mui/icons-material/UploadFile';
import DoneIcon from '@mui/icons-material/CheckCircle';
import AnalysingIcon from '@mui/icons-material/Autorenew';
import { Link as RouterLink } from 'react-router-dom';

import { useApi } from '../services/ApiProvider';
import { useUpload } from '../hooks/useUpload';
import PageHeader from '../components/PageHeader';

const STEPS = ['Select image', 'Patient details', 'Analyse'];

const MAX_BYTES = 40 * 1024 * 1024;

export default function UploadPage() {
  const api = useApi();
  const { status, progress, xrayId, error, result, submit, reset, isBusy } =
    useUpload({ api });

  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [form, setForm] = useState({ patientName: '', mrn: '', appointmentDate: '' });
  const [formErrors, setFormErrors] = useState({});
  const inputRef = useRef(null);

  const activeStep = status === 'done' || isBusy ? 2 : file ? 1 : 0;

  const handleFile = (event) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;

    if (!picked.type.startsWith('image/')) {
      setFileError('That file is not an image. Choose a JPEG, PNG or BMP radiograph.');
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    if (picked.size > MAX_BYTES) {
      setFileError('That image is larger than 40 MB.');
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    setFileError(null);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
    // A filename is a better default than nothing, but the user can overwrite it.
    setForm((prev) => ({
      ...prev,
      patientName: prev.patientName || '',
    }));
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    const errors = {};
    if (!form.patientName.trim()) errors.patientName = 'Patient name is required.';
    setFormErrors(errors);
    if (Object.keys(errors).length > 0 || !file) return;

    await submit({
      file,
      patientName: form.patientName.trim(),
      mrn: form.mrn.trim(),
      appointmentDate: form.appointmentDate,
    });
  };

  const startAnother = () => {
    reset();
    setFile(null);
    setPreviewUrl(null);
    setFileError(null);
    setForm({ patientName: '', mrn: '', appointmentDate: '' });
    setFormErrors({});
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
    disabled: isBusy,
  });

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 2, md: 4 } }}>
      <PageHeader
        title="New Case"
        subtitle="Upload a radiograph, record who it belongs to, and send it for analysis."
      />

      <Stepper activeStep={activeStep} sx={{ mb: 4, maxWidth: 640 }}>
        {STEPS.map((label) => (
          <Step key={label}><StepLabel>{label}</StepLabel></Step>
        ))}
      </Stepper>

      {status === 'done' ? (
        <Card>
          <CardContent sx={{ p: { xs: 3, md: 4 }, textAlign: 'center' }}>
            <DoneIcon sx={{ fontSize: 48, color: 'healthy.main', mb: 1.5 }} />
            <Typography variant="h6" sx={{ mb: 1 }}>
              Analysis complete
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {form.patientName} · {countDetections(result)} teeth detected.
            </Typography>
            <Stack sx={{ justifyContent: 'center' }} direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <Button
                variant="contained"
                component={RouterLink}
                to={`/case/${xrayId}`}
                disableElevation
              >
                Review case
              </Button>
              <Button variant="outlined" onClick={startAnother}>
                Upload another
              </Button>
            </Stack>
          </CardContent>
        </Card>
      ) : (
        <Grid sx={{ alignItems: 'flex-start' }} container spacing={3}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent sx={{ p: { xs: 2, md: 3 } }}>
                <Typography variant="subtitle1" sx={{ mb: 2 }}>
                  1 · Radiograph
                </Typography>

                <Box
                  component="label"
                  sx={{
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    border: '2px dashed', borderColor: file ? 'primary.main' : 'divider',
                    borderRadius: 3, bgcolor: '#fcfcfd',
                    px: 3, py: previewUrl ? 3 : 7, textAlign: 'center',
                    cursor: isBusy ? 'default' : 'pointer',
                    '&:hover': isBusy ? {} : {
                      borderColor: 'primary.main',
                      bgcolor: 'rgba(99, 51, 148, 0.03)',
                    },
                  }}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    hidden
                    accept="image/*"
                    onChange={handleFile}
                    disabled={isBusy}
                  />
                  {previewUrl ? (
                    <>
                      <Box
                        component="img"
                        src={previewUrl}
                        alt="Selected radiograph"
                        sx={{
                          maxWidth: '100%', maxHeight: 200,
                          borderRadius: 2, mb: 1.5,
                        }}
                      />
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {file.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {(file.size / 1024 / 1024).toFixed(1)} MB · click to replace
                      </Typography>
                    </>
                  ) : (
                    <>
                      <UploadIcon sx={{ fontSize: 40, color: 'text.secondary', mb: 1.5 }} />
                      <Typography variant="body1" sx={{ mb: 0.5, fontWeight: 500 }}>
                        Drag and drop, or select an image
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        JPEG, PNG or BMP panoramic radiograph
                      </Typography>
                    </>
                  )}
                </Box>

                {fileError && (
                  <Alert severity="warning" sx={{ mt: 2, borderRadius: 2 }}>
                    {fileError}
                  </Alert>
                )}
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent sx={{ p: { xs: 2, md: 3 } }}>
                <Typography variant="subtitle1" sx={{ mb: 2 }}>
                  2 · Patient details
                </Typography>

                {!file ? (
                  <Typography variant="body2" color="text.secondary">
                    Select a radiograph first.
                  </Typography>
                ) : (
                  <Box component="form" onSubmit={handleSubmit} noValidate>
                    <Stack spacing={2.5}>
                      <TextField
                        label="Patient name"
                        required
                        fullWidth
                        size="small"
                        placeholder="Patient Name"
                        error={Boolean(formErrors.patientName)}
                        helperText={formErrors.patientName}
                        {...field('patientName')}
                      />
                      <TextField
                        label="MRN (record number)"
                        fullWidth
                        size="small"
                        placeholder="MRN-9001"
                        helperText="Leave blank to generate one. Reusing an MRN adds to that patient's history."
                        {...field('mrn')}
                      />
                      <TextField
                        label="Appointment date"
                        type="date"
                        fullWidth
                        size="small"
                        // A date input always renders mm/dd/yyyy, so MUI never
                        // sees an empty field to shrink the label for. MUI 9
                        // dropped InputLabelProps, so this must go through
                        // slotProps or the label sits on the placeholder.
                        slotProps={{ inputLabel: { shrink: true } }}
                        helperText="The queue is ordered by this date."
                        {...field('appointmentDate')}
                      />

                      {status === 'uploading' && (
                        <Box>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                            Uploading… {progress}%
                          </Typography>
                          <LinearProgress variant="determinate" value={progress} />
                        </Box>
                      )}

                      {status === 'analysing' && (
                        <Alert
                          severity="info"
                          icon={<AnalysingIcon />}
                          sx={{ borderRadius: 2 }}
                        >
                          Analysing the radiograph — this takes a few seconds.
                          You can leave this page; the case will appear in the queue.
                        </Alert>
                      )}

                      {status === 'error' && error && (
                        <Alert severity="error" sx={{ borderRadius: 2 }}>
                          {error}
                        </Alert>
                      )}

                      <Button
                        type="submit"
                        variant="contained"
                        size="large"
                        fullWidth
                        disableElevation
                        disabled={isBusy}
                        startIcon={isBusy ? <CircularProgress size={16} color="inherit" /> : null}
                      >
                        {isBusy ? 'Working…' : 'Next — analyse radiograph'}
                      </Button>
                    </Stack>
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
    </Container>
  );
}

function countDetections(caseData) {
  if (!caseData?.detections) return 0;
  return caseData.detections.filter((d) => (d.source || 'detect') === 'detect').length;
}
