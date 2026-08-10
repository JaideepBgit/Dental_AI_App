/**
 * Pick the signature to sign a case with.
 *
 * Saved signatures load with the default preselected, so the common case is zero
 * clicks. Drawing stays available as a fallback -- a clinician who has saved
 * nothing, or who wants a one-off mark, must never be blocked from signing.
 *
 * Reports the selection upward via onChange({signatureId, getDrawn}) rather than
 * exposing a ref: the page needs the drawn image only at submit time, and
 * reading it lazily keeps a large data URL out of React state on every stroke.
 */
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  Alert, Box, Button, CircularProgress, Stack, Typography,
} from '@mui/material';
import DrawIcon from '@mui/icons-material/Gesture';
import { Link as RouterLink } from 'react-router-dom';

import SignaturePad from './SignaturePad';
import { useApi } from '../services/ApiProvider';

const DRAW = '__draw__';

const SignaturePicker = forwardRef(({ disabled }, ref) => {
  const api = useApi();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(DRAW);
  const padRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchSignatures()
      .then((data) => {
        if (cancelled) return;
        const rows = data.items || [];
        setItems(rows);
        // Preselect the default so signing is a single click. With none saved,
        // fall through to the drawing pad.
        const preferred = rows.find((s) => s.is_default) || rows[0];
        setSelected(preferred ? preferred.id : DRAW);
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api]);

  // What the page submits. Exactly one of the two is ever set, matching the
  // server contract on /api/approve.
  useImperativeHandle(ref, () => ({
    getSignature: () => {
      if (selected !== DRAW) return { signatureId: selected };
      const drawn = padRef.current && !padRef.current.isEmpty()
        ? padRef.current.toDataURL()
        : null;
      return { signature: drawn };
    },
    clear: () => padRef.current?.clear(),
  }));

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="warning" sx={{ mb: 1.5, borderRadius: 2 }}>
          Could not load your saved signatures ({error}). Draw one below to sign.
        </Alert>
      )}

      {items.length > 0 && (
        <Stack spacing={1} sx={{ mb: 1.5 }}>
          {items.map((sig) => {
            const active = selected === sig.id;
            return (
              <Stack
                key={sig.id}
                component="button"
                type="button"
                direction="row"
                spacing={1.5}
                disabled={disabled}
                onClick={() => setSelected(sig.id)}
                sx={{
                  alignItems: 'center', p: 1, textAlign: 'left', width: '100%',
                  cursor: disabled ? 'default' : 'pointer',
                  border: '2px solid',
                  borderColor: active ? 'primary.main' : 'divider',
                  borderRadius: 2, bgcolor: active ? 'action.hover' : '#fff',
                  opacity: disabled ? 0.6 : 1,
                }}
              >
                <Box
                  component="img"
                  src={api.signatureImageUrl(sig.id)}
                  alt={sig.label}
                  sx={{ height: 40, width: 120, objectFit: 'contain', flexShrink: 0 }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: active ? 600 : 400 }}>
                    {sig.label}
                  </Typography>
                  {sig.is_default && (
                    <Typography variant="caption" color="text.secondary">default</Typography>
                  )}
                </Box>
              </Stack>
            );
          })}

          <Button
            size="small"
            color="inherit"
            startIcon={<DrawIcon fontSize="small" />}
            onClick={() => setSelected(DRAW)}
            disabled={disabled}
            sx={{
              alignSelf: 'flex-start',
              fontWeight: selected === DRAW ? 600 : 400,
              color: selected === DRAW ? 'primary.main' : 'text.secondary',
            }}
          >
            Draw a one-off signature instead
          </Button>
        </Stack>
      )}

      {selected === DRAW && (
        <Box>
          <Stack
            direction="row"
            sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}
          >
            <Typography variant="body2" color="text.secondary">
              {items.length === 0
                ? 'Sign below, or save a reusable signature in Settings.'
                : 'Sign below for this case only.'}
            </Typography>
            <Button
              size="small"
              color="inherit"
              onClick={() => padRef.current?.clear()}
              disabled={disabled}
            >
              Clear
            </Button>
          </Stack>
          <Box
            sx={{
              border: '1px solid', borderColor: 'divider', borderRadius: 2,
              bgcolor: '#f9fafb', overflow: 'hidden',
            }}
          >
            <SignaturePad ref={padRef} />
          </Box>
          {items.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
              Tired of re-drawing?{' '}
              <Box component={RouterLink} to="/settings" sx={{ color: 'primary.main' }}>
                Save a signature in Settings
              </Box>
              {' '}and it will be attached automatically.
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
});

export default SignaturePicker;
