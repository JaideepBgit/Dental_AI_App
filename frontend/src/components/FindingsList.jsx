import {
  Box, Typography, Stack, Checkbox, Chip, Tooltip, Alert,
  ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import { useState } from 'react';

/**
 * The doctor's worklist for one radiograph. Ticking a row is what marks a tooth
 * for extraction — the model never sets this. Rows are keyed by detection id so
 * the selection survives re-renders.
 */

// Pathology joined onto a tooth from the segmentation model. Muted palette: the
// row's subject is the extraction decision, and a saturated tag would compete
// with the Extract chip for attention.
const FINDING_COLORS = {
  Caries: { bg: '#fee2e2', fg: '#991b1b' },
  'Periapical lesion': { bg: '#ffedd5', fg: '#9a3412' },
  'impacted tooth': { bg: '#fef3c7', fg: '#92400e' },
  'Retained root': { bg: '#ffe4e6', fg: '#9f1239' },
  'Root Piece': { bg: '#ffe4e6', fg: '#9f1239' },
};
const FINDING_FALLBACK = { bg: '#e5e7eb', fg: '#374151' };
export default function FindingsList({
  detections, extractionIds, onToggle, hoveredId, onHover, disabled,
}) {
  const [filter, setFilter] = useState('molars');

  const thirdMolars = detections.filter((d) => d.is_third_molar);
  // Default to third molars — that's the referral's subject — but never hide
  // a tooth the doctor already marked.
  const visible = filter === 'molars'
    ? detections.filter((d) => d.is_third_molar || extractionIds.includes(d.id))
    : detections;

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5, minHeight: 32 }}
      >
        <Typography variant="subtitle1">Teeth for extraction</Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ '& .MuiToggleButton-root': { py: 0.25, px: 1, fontSize: '0.75rem', textTransform: 'none' } }}
        >
          <ToggleButton value="molars">3rd molars ({thirdMolars.length})</ToggleButton>
          <ToggleButton value="all">All ({detections.length})</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {detections.length === 0 && (
        <Alert severity="info" sx={{ borderRadius: 2 }}>
          No teeth were detected in this radiograph.
        </Alert>
      )}

      {detections.length > 0 && visible.length === 0 && (
        <Alert severity="warning" sx={{ borderRadius: 2 }}>
          No third molars identified. Switch to “All” to review every detected tooth.
        </Alert>
      )}

      <Stack spacing={0.5}>
        {visible.map((det) => {
          const checked = extractionIds.includes(det.id);
          const isHovered = hoveredId === det.id;
          return (
            <Stack
              key={det.id}
              direction="row"
              spacing={1}
              onMouseEnter={() => onHover?.(det.id)}
              onMouseLeave={() => onHover?.(null)}
              sx={{
                alignItems: 'center',
                px: 0.75,
                py: 0.375,
                borderRadius: 1,
                border: '1px solid',
                borderColor: checked ? 'impacted.main' : 'divider',
                bgcolor: checked ? 'impacted.light' : (isHovered ? '#f9fafb' : 'transparent'),
                transition: 'background-color .15s, border-color .15s',
                cursor: disabled ? 'default' : 'pointer',
              }}
              onClick={() => !disabled && onToggle(det.id)}
            >
              <Checkbox
                size="small"
                checked={checked}
                disabled={disabled}
                onChange={() => onToggle(det.id)}
                onClick={(e) => e.stopPropagation()}
                sx={{ p: 0.5, color: 'text.secondary', '&.Mui-checked': { color: 'impacted.main' } }}
              />

              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Stack
                  direction="row"
                  spacing={0.75}
                  useFlexGap
                  sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.25 }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {det.fdi_number ? `FDI ${det.fdi_number}` : det.class_name}
                  </Typography>
                  {det.fdi_is_estimated && det.fdi_number && (
                    <Tooltip title="Position inferred from image geometry — verify before signing">
                      <Chip
                        label="est."
                        size="small"
                        sx={{ height: 16, fontSize: '0.65rem', bgcolor: '#e5e7eb' }}
                      />
                    </Tooltip>
                  )}
                  {det.is_third_molar && (
                    <Chip
                      label="3rd molar"
                      size="small"
                      sx={{ height: 16, fontSize: '0.65rem', bgcolor: 'caries.light', color: '#92400e' }}
                    />
                  )}
                  {/*
                    Segmentation findings that overlap this tooth. Spatial
                    correlation, not a diagnosis — the tooltip says so, and
                    nothing here ticks the extraction box.
                  */}
                  {(det.findings || []).map((f) => {
                    const c = FINDING_COLORS[f.class_name] || FINDING_FALLBACK;
                    return (
                      <Tooltip
                        key={`${det.id}-${f.class_name}`}
                        title={`Segmentation model found ${f.class_name} overlapping this tooth (${(f.confidence * 100).toFixed(0)}% confidence). Correlation by position — confirm before acting.`}
                      >
                        <Chip
                          label={f.class_name}
                          size="small"
                          sx={{
                            height: 16, fontSize: '0.65rem',
                            bgcolor: c.bg, color: c.fg,
                          }}
                        />
                      </Tooltip>
                    );
                  })}
                </Stack>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {det.quadrant || 'Unknown quadrant'}
                  {det.universal_number ? ` · Universal ${det.universal_number}` : ''}
                  {` · ${(det.confidence * 100).toFixed(0)}% detection`}
                </Typography>
              </Box>

              {checked && (
                <Chip
                  label="Extract"
                  size="small"
                  sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'impacted.main', color: '#fff' }}
                />
              )}
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}
