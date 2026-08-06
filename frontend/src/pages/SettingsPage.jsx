/**
 * Settings — the dentist's name and the backend's status.
 *
 * The name was previously only editable inside the sign-off panel, which meant
 * retyping it per session with no indication it was remembered.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Card, CardContent, Container, Divider, Stack, TextField,
  Typography,
} from '@mui/material';

import { useApi } from '../services/ApiProvider';
import PageHeader from '../components/PageHeader';
import { DOCTOR_NAME_KEY } from '../hooks/useDoctorName';

export default function SettingsPage() {
  const api = useApi();
  const [doctorName, setDoctorName] = useState(
    () => localStorage.getItem(DOCTOR_NAME_KEY) || '',
  );
  const [health, setHealth] = useState(null);

  useEffect(() => {
    localStorage.setItem(DOCTOR_NAME_KEY, doctorName);
  }, [doctorName]);

  useEffect(() => {
    let cancelled = false;
    api.fetchHealth()
      .then((data) => { if (!cancelled) setHealth(data); })
      .catch(() => { if (!cancelled) setHealth({ status: 'unreachable' }); });
    return () => { cancelled = true; };
  }, [api]);

  const model = health?.model;

  return (
    <Container maxWidth="md" sx={{ py: { xs: 2, md: 4 } }}>
      <PageHeader title="Settings" subtitle="Your details and the state of the analysis backend." />

      <Stack spacing={2.5}>
        <Card>
          <CardContent sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Attending dentist</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Pre-fills the sign-off panel and appears on every referral you sign.
              Stored in this browser only.
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="Your name"
              placeholder="Doctor Name"
              value={doctorName}
              onChange={(e) => setDoctorName(e.target.value)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ mb: 2 }}>Backend status</Typography>

            {health?.status === 'unreachable' ? (
              <Alert severity="error" sx={{ borderRadius: 2 }}>
                Cannot reach the API. Start it with <code>python main.py</code>.
              </Alert>
            ) : (
              <Stack spacing={1.5} divider={<Divider />}>
                <Row label="API" value={health?.status === 'ok' ? 'Connected' : 'Checking…'} />
                <Row
                  label="Voice dictation"
                  value={health?.whisper === 'ready'
                    ? 'Local Whisper ready'
                    : 'Unavailable — browser dictation will be used'}
                />
                <Row label="Detection model" value={model?.path || '—'} />
                <Row
                  label="Capability"
                  value={model?.supports_pathology
                    ? 'Detection and pathology'
                    : 'Detection only — clinical findings are yours'}
                />
                {model?.num_classes != null && (
                  <Row label="Classes" value={String(model.num_classes)} />
                )}
              </Stack>
            )}

            {model?.error && (
              <Alert severity="warning" sx={{ mt: 2, borderRadius: 2 }}>
                Model not loaded: {model.error}
              </Alert>
            )}
          </CardContent>
        </Card>
      </Stack>
    </Container>
  );
}

function Row({ label, value }) {
  return (
    <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 500, textAlign: 'right', minWidth: 0 }}>
        {value}
      </Typography>
    </Stack>
  );
}
