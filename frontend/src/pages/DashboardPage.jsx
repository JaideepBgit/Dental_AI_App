/**
 * Dashboard — the landing page.
 *
 * Deliberately not the queue: arriving on a list of one patient makes the
 * product look like a single tool. This shows the shape of the whole workload
 * and points at the two things a user actually starts with.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Container, Grid, Skeleton, Stack,
  Typography,
} from '@mui/material';
import NewCaseIcon from '@mui/icons-material/AddPhotoAlternate';
import QueueIcon from '@mui/icons-material/FactCheck';
import { Link as RouterLink } from 'react-router-dom';

import { useApi } from '../services/ApiProvider';
import PageHeader from '../components/PageHeader';

const TILES = [
  { key: 'awaiting_review', label: 'Awaiting review', to: '/queue?status=PROCESSED', tone: 'primary' },
  { key: 'pending', label: 'Processing', to: '/queue?status=PENDING', tone: 'muted' },
  { key: 'approved', label: 'Signed off', to: '/queue?status=APPROVED', tone: 'healthy' },
  { key: 'failed', label: 'Failed', to: '/queue?status=ERROR', tone: 'impacted' },
];

const TONES = {
  primary: { color: 'primary.main' },
  healthy: { color: 'healthy.main' },
  impacted: { color: 'impacted.main' },
  muted: { color: 'text.secondary' },
};

function StatTile({ label, value, to, tone, loading }) {
  return (
    <Card
      component={RouterLink}
      to={to}
      sx={{
        display: 'block', textDecoration: 'none', height: '100%',
        transition: 'border-color 120ms',
        '&:hover': { borderColor: 'primary.main' },
      }}
    >
      <CardContent sx={{ p: 2.5 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
          {label}
        </Typography>
        {loading ? (
          <Skeleton variant="text" width={56} height={44} />
        ) : (
          <Typography
            variant="h4"
            sx={{ fontWeight: 600, letterSpacing: '-0.03em', ...TONES[tone] }}
          >
            {value}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const api = useApi();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchStats()
      .then((data) => { if (!cancelled) setStats(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [api]);

  const loading = !stats && !error;

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 2, md: 4 } }}>
      <PageHeader
        title="Dashboard"
        subtitle="Today's radiograph workload across the practice."
        action={
          <Stack direction="row" spacing={1.5}>
            <Button
              variant="contained"
              component={RouterLink}
              to="/upload"
              startIcon={<NewCaseIcon />}
              disableElevation
            >
              New Case
            </Button>
            <Button
              variant="outlined"
              component={RouterLink}
              to="/queue"
              startIcon={<QueueIcon />}
            >
              Review Queue
            </Button>
          </Stack>
        }
      />

      {error && (
        <Alert severity="error" sx={{ mb: 3, borderRadius: 2 }}>
          Could not load statistics: {error}
        </Alert>
      )}

      <Grid container spacing={2.5} sx={{ mb: 4 }}>
        {TILES.map((tile) => (
          <Grid key={tile.key} size={{ xs: 6, md: 3 }}>
            <StatTile
              label={tile.label}
              value={stats?.[tile.key] ?? 0}
              to={tile.to}
              tone={tile.tone}
              loading={loading}
            />
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ height: '100%' }}>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="subtitle1" sx={{ mb: 2 }}>
                Practice totals
              </Typography>
              <Stack spacing={1.5}>
                <SummaryRow
                  label="Radiographs analysed"
                  value={stats?.total ?? 0}
                  loading={loading}
                />
                <SummaryRow
                  label="Patients on record"
                  value={stats?.patients ?? 0}
                  loading={loading}
                />
                <SummaryRow
                  label="Third molars detected"
                  value={stats?.third_molars_flagged ?? 0}
                  loading={loading}
                />
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ height: '100%' }}>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>
                How cases arrive
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                The RPA drops radiographs into the inbox folder automatically and
                they appear in the queue once analysed. Use New Case to add one
                by hand with the patient's details.
              </Typography>
              <Button
                component={RouterLink}
                to="/upload"
                variant="outlined"
                startIcon={<NewCaseIcon />}
              >
                New Case
              </Button>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
}

function SummaryRow({ label, value, loading }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      {loading
        ? <Skeleton variant="text" width={32} />
        : <Typography variant="body2" sx={{ fontWeight: 600 }}>{value}</Typography>}
    </Stack>
  );
}
