/**
 * The gate in front of every destructive action.
 *
 * Deletion here is irreversible — rows cascade and the files are unlinked from
 * disk — so this is the one component standing between a stray click and a lost
 * radiograph. Pass `requireMrn` for the cases that deserve more than a reflex
 * confirm: destroying a signed referral, or removing a whole patient.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, TextField,
} from '@mui/material';

export default function ConfirmDeleteDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  requireMrn = null,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}) {
  const [typed, setTyped] = useState('');

  // Reset on every open. A value left over from the previous dialog would
  // satisfy the gate immediately and let the next delete through untyped.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const gateMet = !requireMrn
    || typed.trim().toLowerCase() === String(requireMrn).trim().toLowerCase();
  const blocked = busy || !gateMet;

  const handleConfirm = () => {
    if (blocked) return;
    onConfirm();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>{title}</DialogTitle>

      <DialogContent>
        <DialogContentText variant="body2" sx={{ mb: requireMrn ? 2.5 : 0 }}>
          {description}
        </DialogContentText>

        {requireMrn && (
          <TextField
            autoFocus
            fullWidth
            size="small"
            label={`Type MRN ${requireMrn} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
          />
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>{error}</Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onCancel} disabled={busy} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={blocked}
          variant="contained"
          disableElevation
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null}
          sx={{
            bgcolor: 'impacted.main',
            '&:hover': { bgcolor: '#dc2626' },
          }}
        >
          {busy ? 'Deleting…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
