import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Typography, CircularProgress, Chip, Stack, Slider, ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';

/**
 * Full-dentition viewer for the 128-class hierarchical model.
 *
 * Unlike the detector behind the Detection tab, this model's classes name the
 * quadrant and the position ('Q3_tooth_8_caries'), so every box arrives already
 * numbered — no geometric ranking, and a first molar is labelled a first molar
 * rather than being forced into one of four wisdom-tooth labels.
 *
 * Geometry follows Viewer.jsx and SegmentationViewer.jsx: the radiograph is an
 * <image> INSIDE the SVG, so one viewBox governs both and boxes cannot drift
 * from the anatomy when height is the binding constraint.
 */

// Third molars are the clinical subject of this app, so they are the only teeth
// given a distinct hue. Everything else is one neutral colour: with up to 32
// boxes on screen, per-tooth colours read as noise rather than information.
const THIRD_MOLAR_COLOR = '#f59e0b';
const TOOTH_COLOR = '#38bdf8';
const UNNUMBERED_COLOR = '#64748b';

// Disease token -> colour, used only for the small tag under a hovered tooth.
const DISEASE_COLORS = {
  'impacted': '#f59e0b',
  'caries': '#ef4444',
  'deep caries': '#dc2626',
  'periapical lesion': '#f97316',
};

function colorFor(det) {
  if (det.is_third_molar) return THIRD_MOLAR_COLOR;
  if (!det.fdi_number) return UNNUMBERED_COLOR;
  return TOOTH_COLOR;
}

export default function DentitionViewer({
  imageUrl, detections, isAnalyzing, hoveredId, onHover,
}) {
  const [size, setSize] = useState(null);
  const [failed, setFailed] = useState(false);
  const [minConf, setMinConf] = useState(0.25);
  const [scope, setScope] = useState('third');
  const imgRef = useRef(null);

  useEffect(() => {
    setSize(null);
    setFailed(false);
  }, [imageUrl]);

  // Memoised on `detections` itself, not a defaulted copy: `detections || []`
  // would be a new identity every render and defeat the memo.
  const all = useMemo(() => detections || [], [detections]);

  const visible = useMemo(() => all.filter((d) => {
    if (d.confidence < minConf) return false;
    if (scope === 'third') return d.is_third_molar;
    return true;
  }), [all, minConf, scope]);

  const thirdMolarCount = all.filter((d) => d.is_third_molar).length;

  // Scale strokes/text to image width so a 3000px and an 800px panoramic look
  // the same on screen.
  const unit = size ? size.w / 2000 : 1;

  return (
    <Box>
      <Box
        sx={{
          bgcolor: '#0f172a',
          borderRadius: 3,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 420,
          p: { xs: 1.5, md: 2 },
          boxShadow: 'inset 0px 4px 20px rgba(0,0,0,0.3)',
        }}
      >
        <Box sx={{ position: 'relative', width: '100%', lineHeight: 0 }}>
          {isAnalyzing && (
            <Box
              position="absolute"
              sx={{
                inset: 0, zIndex: 10, borderRadius: 1,
                bgcolor: 'rgba(15,23,42,0.7)', backdropFilter: 'blur(4px)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <CircularProgress size={40} thickness={4} sx={{ color: '#38bdf8' }} />
              <Typography variant="body2" sx={{ color: '#e2e8f0', mt: 2, fontWeight: 500 }}>
                Reading dentition…
              </Typography>
            </Box>
          )}

          {/* Hidden probe: reads intrinsic pixel dimensions to set the viewBox. */}
          <img
            ref={imgRef}
            src={imageUrl}
            alt=""
            aria-hidden="true"
            onLoad={(e) => setSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
            onError={() => setFailed(true)}
            style={{ display: 'none' }}
          />

          {failed && (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Typography variant="body2" sx={{ color: '#fca5a5' }}>
                Could not load this radiograph.
              </Typography>
            </Box>
          )}

          {!size && !failed && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress size={28} sx={{ color: '#38bdf8' }} />
            </Box>
          )}

          {size && !failed && (
            <Box
              component="svg"
              viewBox={`0 0 ${size.w} ${size.h}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Panoramic radiograph with numbered teeth"
              sx={{
                display: 'block',
                width: '100%',
                maxHeight: '68vh',
                borderRadius: 1,
                overflow: 'hidden',
              }}
            >
              <image
                href={imageUrl}
                x={0}
                y={0}
                width={size.w}
                height={size.h}
                preserveAspectRatio="none"
              />

              {visible.map((det) => {
                const color = colorFor(det);
                const isHovered = hoveredId === det.id;
                const [x1, y1, x2, y2] = det.bbox;

                return (
                  <rect
                    key={`box-${det.id}`}
                    x={x1} y={y1} width={x2 - x1} height={y2 - y1}
                    rx={4 * unit}
                    fill={color}
                    fillOpacity={isHovered ? 0.25 : 0.06}
                    stroke={color}
                    strokeWidth={(isHovered ? 6 : det.is_third_molar ? 4 : 2.5) * unit}
                    onMouseEnter={() => onHover?.(det.id)}
                    onMouseLeave={() => onHover?.(null)}
                    style={{ cursor: 'pointer', transition: 'stroke-width 0.15s ease-out' }}
                  />
                );
              })}

              {/*
                FDI number sits on every numbered tooth — it is the point of
                this tab. The disease token is held back for the hover label:
                32 always-on pathology tags would bury the radiograph.
              */}
              {visible.filter((d) => d.fdi_number).map((det) => {
                const color = colorFor(det);
                const [x1, y1, x2] = det.bbox;
                const cx = (x1 + x2) / 2;
                const fontSize = (det.is_third_molar ? 34 : 26) * unit;
                const boxW = fontSize * 1.9;
                const boxH = fontSize * 1.35;

                // Sit above the tooth, flipping below when there is no room,
                // and stay inside the frame horizontally.
                const above = y1 - boxH - 6 * unit > 0;
                const boxY = above ? y1 - boxH - 6 * unit : y1 + 6 * unit;
                const boxX = Math.min(Math.max(cx - boxW / 2, 0), size.w - boxW);

                return (
                  <g key={`num-${det.id}`} style={{ pointerEvents: 'none' }}>
                    <rect
                      x={boxX} y={boxY} width={boxW} height={boxH}
                      fill={color} rx={3 * unit}
                      fillOpacity={det.is_third_molar ? 1 : 0.85}
                    />
                    <text
                      x={boxX + boxW / 2}
                      y={boxY + boxH / 2 + fontSize * 0.35}
                      textAnchor="middle"
                      fill="#0f172a"
                      fontSize={fontSize}
                      fontWeight="700"
                      fontFamily="Inter, sans-serif"
                    >
                      {det.fdi_number}
                    </text>
                  </g>
                );
              })}

              {/* Hovered tooth only: confidence and the model's disease token. */}
              {visible.filter((det) => det.id === hoveredId).map((det) => {
                const [x1, y1, x2, y2] = det.bbox;
                const cx = (x1 + x2) / 2;
                const parts = [`${(det.confidence * 100).toFixed(0)}%`];
                if (det.disease) parts.push(det.disease);
                const label = parts.join(' · ');

                const fontSize = 26 * unit;
                const boxW = label.length * fontSize * 0.58 + 16 * unit;
                const boxH = fontSize * 1.5;
                const boxY = y2 + 8 * unit;
                const boxX = Math.min(Math.max(cx - boxW / 2, 0), size.w - boxW);
                const bg = DISEASE_COLORS[det.disease] || '#1e293b';

                return (
                  <g key={`meta-${det.id}`} style={{ pointerEvents: 'none' }}>
                    <rect
                      x={boxX} y={boxY} width={boxW} height={boxH}
                      fill={bg} rx={4 * unit} fillOpacity={0.95}
                    />
                    <text
                      x={boxX + boxW / 2}
                      y={boxY + boxH / 2 + fontSize * 0.35}
                      textAnchor="middle"
                      fill="#ffffff"
                      fontSize={fontSize}
                      fontWeight="600"
                      fontFamily="Inter, sans-serif"
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </Box>
          )}
        </Box>
      </Box>

      {/* Controls: scope toggle + confidence floor */}
      <Stack spacing={1.5} sx={{ mt: 2 }}>
        <Stack sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={scope}
            onChange={(_, v) => v && setScope(v)}
            sx={{ flexShrink: 0 }}
          >
            <ToggleButton value="third" sx={{ px: 1.5, py: 0.4, fontSize: '0.72rem' }}>
              3rd molars ({thirdMolarCount})
            </ToggleButton>
            <ToggleButton value="all" sx={{ px: 1.5, py: 0.4, fontSize: '0.72rem' }}>
              All teeth ({all.length})
            </ToggleButton>
          </ToggleButtonGroup>

          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexGrow: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
              Min. confidence
            </Typography>
            <Slider
              size="small"
              value={minConf}
              onChange={(_, v) => setMinConf(v)}
              min={0}
              max={0.95}
              step={0.05}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${(v * 100).toFixed(0)}%`}
              sx={{ maxWidth: 200 }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
              {visible.length} shown
            </Typography>
          </Stack>
        </Stack>

        <Stack sx={{ flexWrap: 'wrap' }} direction="row" spacing={0.75} useFlexGap>
          {[
            ['3rd molar', THIRD_MOLAR_COLOR],
            ['Numbered tooth', TOOTH_COLOR],
            ['Unnumbered', UNNUMBERED_COLOR],
          ].map(([label, color]) => (
            <Chip
              key={label}
              size="small"
              label={label}
              sx={{
                height: 24,
                fontSize: '0.7rem',
                bgcolor: `${color}1F`,
                border: '1px solid',
                borderColor: `${color}66`,
                '& .MuiChip-label': { px: 0.75 },
                '&::before': {
                  content: '""',
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: color,
                  ml: 0.75,
                  flexShrink: 0,
                },
              }}
            />
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
