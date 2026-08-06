import { Chip, Tooltip } from '@mui/material';

/** One place that decides how each lifecycle status looks and reads. */
const STATUS_STYLES = {
  PENDING: { label: 'Processing', bgcolor: '#e5e7eb', color: '#374151' },
  PROCESSED: { label: 'Awaiting review', bgcolor: 'rgba(99, 51, 148, 0.1)', color: 'rgb(99, 51, 148)' },
  APPROVED: { label: 'Signed off', bgcolor: '#d1fae5', color: '#065f46' },
  ERROR: { label: 'Failed', bgcolor: '#fee2e2', color: '#991b1b' },
};

export default function StatusChip({ status, title }) {
  const style = STATUS_STYLES[status] || { label: status || 'Unknown', bgcolor: '#e5e7eb', color: '#374151' };

  const chip = (
    <Chip
      size="small"
      label={style.label}
      sx={{ height: 22, fontSize: '0.7rem', bgcolor: style.bgcolor, color: style.color }}
    />
  );

  return title ? <Tooltip title={title}>{chip}</Tooltip> : chip;
}
