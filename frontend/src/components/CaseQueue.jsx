import {
  Box, List, ListItemButton, Typography, Stack, Chip, Divider,
  CircularProgress, IconButton, Tooltip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ApprovedIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/ErrorOutlineOutlined';

function formatAppointment(value) {
  if (!value) return 'No date';
  // Parse as local, not UTC: 'new Date("2026-08-06")' is midnight UTC and can
  // render as the previous day west of Greenwich.
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return value;
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((date - today) / 86400000);
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  if (days > 1) return `${label} · in ${days}d`;
  return `${label} · ${Math.abs(days)}d ago`;
}

export default function CaseQueue({
  items, selectedId, onSelect, loading, onRefresh,
}) {
  const pending = items.filter((i) => i.status !== 'APPROVED');
  const done = items.filter((i) => i.status === 'APPROVED');

  const renderItem = (item) => {
    const isSelected = item.id === selectedId;
    const isApproved = item.status === 'APPROVED';
    const isError = item.status === 'ERROR';

    return (
      <ListItemButton
        key={item.id}
        selected={isSelected}
        onClick={() => onSelect(item.id)}
        sx={{
          borderRadius: 2,
          mb: 0.5,
          alignItems: 'flex-start',
          flexDirection: 'column',
          gap: 0.5,
          '&.Mui-selected': {
            bgcolor: 'primary.light',
            '&:hover': { bgcolor: '#dcecff' },
          },
        }}
      >
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', width: '100%' }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 600, flexGrow: 1, minWidth: 0 }}
            noWrap
            title={item.patient_name}
          >
            {item.patient_name}
          </Typography>
          {isApproved && (
            <Tooltip title="Signed off">
              <ApprovedIcon sx={{ fontSize: 16, color: 'healthy.main' }} />
            </Tooltip>
          )}
          {isError && (
            <Tooltip title={item.error_message || 'Processing failed'}>
              <ErrorIcon sx={{ fontSize: 16, color: 'impacted.main' }} />
            </Tooltip>
          )}
        </Stack>

        <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: '100%' }}>
          {item.mrn} · {formatAppointment(item.appointment_date)}
        </Typography>

        <Stack sx={{ flexWrap: 'wrap' }} direction="row" spacing={0.5} useFlexGap>
          <Chip
            label={`${item.num_detections} teeth`}
            size="small"
            sx={{ height: 20, fontSize: '0.7rem' }}
          />
          {item.num_third_molars > 0 && (
            <Chip
              label={`${item.num_third_molars} 3rd molar${item.num_third_molars > 1 ? 's' : ''}`}
              size="small"
              sx={{
                height: 20,
                fontSize: '0.7rem',
                bgcolor: 'caries.light',
                color: '#92400e',
              }}
            />
          )}
          {item.marked_for_extraction > 0 && (
            <Chip
              label={`${item.marked_for_extraction} extraction`}
              size="small"
              sx={{
                height: 20,
                fontSize: '0.7rem',
                bgcolor: 'impacted.light',
                color: '#991b1b',
              }}
            />
          )}
        </Stack>
      </ListItemButton>
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}
      >
        <Typography variant="subtitle1">
          Review queue
          {pending.length > 0 && (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.75 }}>
              ({pending.length})
            </Typography>
          )}
        </Typography>
        <Stack sx={{ alignItems: 'center' }} direction="row" spacing={0.5}>
          {loading && <CircularProgress size={14} thickness={5} />}
          <Tooltip title="Refresh queue">
            <IconButton size="small" onClick={onRefresh} disabled={loading}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Box sx={{ overflowY: 'auto', flexGrow: 1, minHeight: 0, p: 1 }}>
        {items.length === 0 && !loading && (
          <Box sx={{ px: 2, py: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No cases in the queue.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Drop X-rays into the inbox folder, or upload one manually.
            </Typography>
          </Box>
        )}

        <List disablePadding>
          {pending.map(renderItem)}

          {done.length > 0 && (
            <>
              <Divider sx={{ my: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Signed off ({done.length})
                </Typography>
              </Divider>
              {done.map(renderItem)}
            </>
          )}
        </List>
      </Box>
    </Box>
  );
}
