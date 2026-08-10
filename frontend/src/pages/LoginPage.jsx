/**
 * Sign-in screen. The only route reachable without a session.
 *
 * Renders outside AppShell — showing the nav rail to someone who cannot use it
 * would advertise the app's surface before they are allowed in.
 */
import { useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, Stack, TextField,
  Typography,
} from '@mui/material';
import LoginIcon from '@mui/icons-material/Login';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { PRACTICE_NAME, PRACTICE_TAGLINE } from '../branding';
import { useAuth } from '../services/AuthProvider';

export default function LoginPage() {
  const { login, isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  // Already signed in: bounce to wherever they were headed, or the dashboard.
  if (isAuthenticated) {
    return <Navigate to={location.state?.from || '/'} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const me = await login(email, password);
      // Admins land on their console; a doctor lands on the queue, which is the
      // only place they work from.
      const target = location.state?.from || (me.role === 'ADMIN' ? '/admin' : '/queue');
      navigate(target, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed.');
      setSubmitting(false);
    }
  }

  return (
    <Box
      sx={{
        display: 'grid', placeItems: 'center', minHeight: '100vh',
        bgcolor: 'background.default', p: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
            <Box
              component="img"
              src="/passion-dental-logo.png"
              alt="Passion Dental"
              sx={{
                width: 76, height: 76, objectFit: 'contain',
              }}
            />
            <Typography variant="h5" sx={{ fontWeight: 600, color: 'primary.dark' }}>
              {PRACTICE_NAME}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {PRACTICE_TAGLINE}
            </Typography>
          </Stack>

          <form onSubmit={handleSubmit}>
            <Stack spacing={2}>
              {/* type="text", not "email": logins may be bare usernames like
                  'admin', which a type="email" field would reject client-side. */}
              <TextField
                label="Username"
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                fullWidth
                autoFocus
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                fullWidth
              />

              {error && <Alert severity="error">{error}</Alert>}

              <Button
                type="submit"
                variant="contained"
                size="large"
                disableElevation
                disabled={submitting}
                startIcon={submitting
                  ? <CircularProgress size={18} color="inherit" />
                  : <LoginIcon />}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </Button>

              <Typography variant="caption" color="text.secondary" align="center">
                Access is restricted to authorised practice staff. Activity is logged.
              </Typography>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
