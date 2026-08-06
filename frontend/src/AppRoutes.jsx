/**
 * Route table and the shell every page renders inside.
 *
 * Kept separate from App so tests can mount it inside their own MemoryRouter
 * and ApiProvider without the real BrowserRouter or axios client.
 *
 * /login renders bare. Every other route sits behind RequireAuth, and /admin
 * additionally requires the ADMIN role. These guards are for navigation only --
 * the backend enforces the same rules on every endpoint, so a hand-typed URL
 * gains nothing.
 */
import { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Container, Typography } from '@mui/material';
import { Link as RouterLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import AppShell from './components/AppShell';
import AdminPage from './pages/AdminPage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import UploadPage from './pages/UploadPage';
import QueuePage from './pages/QueuePage';
import CaseReviewPage from './pages/CaseReviewPage';
import PatientsPage, { PatientDetailPage } from './pages/PatientsPage';
import ReferralsPage from './pages/ReferralsPage';
import SettingsPage from './pages/SettingsPage';
import { useApi } from './services/ApiProvider';
import { useAuth } from './services/AuthProvider';

function NotFoundPage() {
  return (
    <Container maxWidth="sm" sx={{ py: 12, textAlign: 'center' }}>
      <Typography variant="h5" sx={{ fontWeight: 600, mb: 1 }}>
        Page not found
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        That page does not exist.
      </Typography>
      <Button variant="contained" component={RouterLink} to="/" disableElevation>
        Back to dashboard
      </Button>
    </Container>
  );
}

function FullPageSpinner() {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <CircularProgress />
    </Box>
  );
}

/** Blocks a route until a session exists, remembering where the user was headed. */
function RequireAuth({ children }) {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

/**
 * Admin-only. A doctor is sent to their queue rather than shown a 403 -- the
 * queue is their home, and the dashboard is admin-only too.
 */
function RequireAdmin({ children }) {
  const { loading, isAuthenticated, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (!isAdmin) return <Navigate to="/queue" replace />;
  return children;
}

/** The authenticated app: shell, nav badges, and the protected route table. */
function AuthenticatedApp() {
  const api = useApi();
  const { isAuthenticated } = useAuth();
  const [health, setHealth] = useState(null);
  const [badges, setBadges] = useState({});

  useEffect(() => {
    let cancelled = false;
    api.fetchHealth()
      .then((data) => { if (!cancelled) setHealth(data); })
      .catch(() => { if (!cancelled) setHealth({ status: 'unreachable' }); });
    return () => { cancelled = true; };
  }, [api]);

  // Queue badge: how many cases are waiting for a dentist right now. Gated on
  // the session because /api/stats now requires authentication.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let cancelled = false;
    api.fetchStats()
      .then((stats) => {
        if (!cancelled) setBadges({ '/queue': stats.awaiting_review || 0 });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, isAuthenticated]);

  return (
    <AppShell health={health} badges={badges}>
      <Routes>
        {/* Practice-wide screens are admin-only. A doctor lands on their queue. */}
        <Route path="/" element={<HomeRoute />} />
        <Route path="/upload" element={<RequireAdmin><UploadPage /></RequireAdmin>} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/case/:id" element={<CaseReviewPage />} />
        <Route path="/patients" element={<RequireAdmin><PatientsPage /></RequireAdmin>} />
        <Route
          path="/patients/:mrn"
          element={<RequireAdmin><PatientDetailPage /></RequireAdmin>}
        />
        <Route path="/referrals" element={<ReferralsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<RequireAdmin><AdminPage /></RequireAdmin>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}

/** '/' is the dashboard for an admin and the queue for a doctor. */
function HomeRoute() {
  const { isAdmin } = useAuth();
  return isAdmin ? <DashboardPage /> : <Navigate to="/queue" replace />;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="*"
        element={<RequireAuth><AuthenticatedApp /></RequireAuth>}
      />
    </Routes>
  );
}
