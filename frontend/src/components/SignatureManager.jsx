/**
 * Manage the reusable signatures a clinician signs cases with.
 *
 * Two ways in, because practices differ: upload a scan of a wet signature, or
 * draw one once on the canvas and save it. Either way it is stored server-side
 * and picked at sign-off instead of being re-drawn per case.
 *
 * Strictly the signed-in clinician's own signatures. There is deliberately no
 * admin path to create a signature for somebody else -- a signature another
 * person can attach to a clinical record is a forgery, so the doctor supplies
 * their own.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog,
  DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField,
  ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import UploadIcon from '@mui/icons-material/UploadFile';
import DrawIcon from '@mui/icons-material/Gesture';

import SignaturePad from './SignaturePad';
import { useApi } from '../services/ApiProvider';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 2 * 1024 * 1024;

export default function SignatureManager() {
  const api = useApi();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = async () => {
    try {
      const data = await api.fetchSignatures();
      setItems(data.items || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api.fetchSignatures()
      .then((data) => { if (!cancelled) { setItems(data.items || []); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api]);

  const handleMakeDefault = async (id) => {
    setBusyId(id);
    try {
      await api.updateSignature(id, { makeDefault: true });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await api.deleteSignature(id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardContent sx={{ p: 3 }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 0.5 }}
        >
          <Box>
            <Typography variant="subtitle1" sx={{ mb: 0.5 }}>My signatures</Typography>
            <Typography variant="body2" color="text.secondary">
              Upload an image of your signature or draw one once. The default is
              attached automatically when you sign and record a decision.
            </Typography>
          </Box>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => setAddOpen(true)}
            sx={{ flexShrink: 0 }}
          >
            Add
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : items.length === 0 ? (
          <Alert severity="info" sx={{ mt: 2, borderRadius: 2 }}>
            No saved signatures yet. Add one and it becomes your default, so
            sign-off no longer needs a fresh drawing every time.
          </Alert>
        ) : (
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            {items.map((sig) => (
              <Stack
                key={sig.id}
                direction="row"
                spacing={2}
                sx={{
                  alignItems: 'center', p: 1.5,
                  border: '1px solid', borderColor: sig.is_default ? 'primary.main' : 'divider',
                  borderRadius: 2, bgcolor: sig.is_default ? 'action.hover' : 'transparent',
                }}
              >
                <Box
                  component="img"
                  src={api.signatureImageUrl(sig.id)}
                  alt={sig.label}
                  sx={{
                    height: 48, width: 140, objectFit: 'contain',
                    bgcolor: '#fff', borderRadius: 1, flexShrink: 0,
                    border: '1px solid', borderColor: 'divider',
                  }}
                />
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                      {sig.label}
                    </Typography>
                    {sig.is_default && (
                      <Chip label="default" size="small" color="primary"
                            sx={{ height: 18, fontSize: '0.65rem' }} />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {sig.source === 'drawn' ? 'Drawn' : 'Uploaded image'}
                  </Typography>
                </Box>

                <Tooltip title={sig.is_default ? 'This is your default' : 'Make default'}>
                  <IconButton
                    size="small"
                    disabled={sig.is_default || busyId === sig.id}
                    onClick={() => handleMakeDefault(sig.id)}
                  >
                    {sig.is_default ? <StarIcon fontSize="small" color="primary" />
                      : <StarBorderIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete. Cases already signed keep their signature.">
                  <IconButton
                    size="small"
                    disabled={busyId === sig.id}
                    onClick={() => handleDelete(sig.id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
        )}

        <AddSignatureDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); load(); }}
          hasExisting={items.length > 0}
        />
      </CardContent>
    </Card>
  );
}

/** Add one signature, by upload or by drawing. */
function AddSignatureDialog({ open, onClose, onSaved, hasExisting }) {
  const api = useApi();
  const [mode, setMode] = useState('upload');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState(null);
  const [makeDefault, setMakeDefault] = useState(!hasExisting);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const padRef = useRef(null);

  // Reset on each open so a previous attempt's file or drawing is never
  // silently reused.
  useEffect(() => {
    if (!open) return;
    setMode('upload');
    setLabel('');
    setFile(null);
    setMakeDefault(!hasExisting);
    setError(null);
    setSaving(false);
  }, [open, hasExisting]);

  const pickFile = (event) => {
    const chosen = event.target.files?.[0] || null;
    setError(null);
    if (chosen && chosen.size > MAX_BYTES) {
      setError('That image is larger than 2 MB. Use a smaller scan or crop it.');
      setFile(null);
      return;
    }
    setFile(chosen);
  };

  const save = async () => {
    setError(null);
    const cleanLabel = label.trim();
    if (!cleanLabel) {
      setError('Give the signature a label, e.g. "Full signature".');
      return;
    }

    let imageData;
    if (mode === 'draw') {
      if (!padRef.current || padRef.current.isEmpty()) {
        setError('Draw your signature in the box first.');
        return;
      }
      imageData = padRef.current.toDataURL();
    } else if (!file) {
      setError('Choose a PNG, JPG or WEBP image of your signature.');
      return;
    }

    setSaving(true);
    try {
      await api.createSignature({
        label: cleanLabel,
        file: mode === 'upload' ? file : undefined,
        imageData: mode === 'draw' ? imageData : undefined,
        makeDefault,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add a signature</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={mode}
            onChange={(_, next) => { if (next) { setMode(next); setError(null); } }}
          >
            <ToggleButton value="upload">
              <UploadIcon fontSize="small" sx={{ mr: 0.75 }} />
              Upload image
            </ToggleButton>
            <ToggleButton value="draw">
              <DrawIcon fontSize="small" sx={{ mr: 0.75 }} />
              Draw it
            </ToggleButton>
          </ToggleButtonGroup>

          <TextField
            label="Label"
            size="small"
            fullWidth
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Full signature"
            helperText="How it appears in the picker at sign-off."
            inputProps={{ maxLength: 60 }}
          />

          {mode === 'upload' ? (
            <Box>
              <Button
                component="label"
                variant="outlined"
                fullWidth
                startIcon={<UploadIcon />}
                sx={{ py: 1.5 }}
              >
                {file ? file.name : 'Choose image (PNG, JPG, WEBP — max 2 MB)'}
                <input hidden type="file" accept={ACCEPT} onChange={pickFile} />
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                A signature on white paper, scanned or photographed, works best.
              </Typography>
            </Box>
          ) : (
            <Box>
              <Stack
                direction="row"
                sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}
              >
                <Typography variant="body2" color="text.secondary">
                  Sign inside the box.
                </Typography>
                <Button size="small" color="inherit" onClick={() => padRef.current?.clear()}>
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
            </Box>
          )}

          <Button
            size="small"
            color="inherit"
            startIcon={makeDefault ? <StarIcon fontSize="small" color="primary" />
              : <StarBorderIcon fontSize="small" />}
            onClick={() => setMakeDefault((v) => !v)}
            sx={{ alignSelf: 'flex-start' }}
            disabled={!hasExisting}
          >
            {hasExisting
              ? (makeDefault ? 'Will be my default' : 'Make this my default')
              : 'Your first signature becomes the default'}
          </Button>

          {error && <Alert severity="error" sx={{ borderRadius: 2 }}>{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button
          onClick={save}
          variant="contained"
          disableElevation
          disabled={saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {saving ? 'Saving…' : 'Save signature'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
