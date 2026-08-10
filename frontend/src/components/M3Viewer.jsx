import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Typography, CircularProgress, Chip, Stack, Slider, ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';

/**
 * Wisdom-tooth viewer for the 5-class M3 detector.
 *
 * This model answers the same question as the Detection tab, but its classes
 * (M3_UR / M3_UL / M3_LL / M3_LR) name WHICH wisdom tooth, so every third molar
 * arrives already identified. The Detection tab's 2-class detector can only say
 * "a 3rd molar" and has to fall back on geometry — arch split, midline, ranking
 * outward — which mislabels teeth on partially-detected arches. Nothing here is
 * ever geometric, which is what this tab exists to demonstrate.
 *
 * Each of the four wisdom teeth gets its own hue, unlike DentitionViewer where
 * they share one: telling them apart is the entire claim under test, so a
 * mislabelled quadrant should be visible at a glance rather than requiring the
 * reader to check a number.
 *
 * Geometry follows Viewer.jsx / SegmentationViewer.jsx / DentitionViewer.jsx:
 * the radiograph is an <image> INSIDE the SVG, so one viewBox governs both and
 * boxes cannot drift from the anatomy when height is the binding constraint.
 */

// One hue per wisdom tooth, keyed by the model's own class name.
const M3_COLORS = {
  M3_UR: '#f59e0b',
  M3_UL: '#22c55e',
  M3_LL: '#38bdf8',
  M3_LR: '#a855f7',
};
const TOOTH_COLOR = '#64748b';

// Quadrant names for the hover label, in patient anatomy.
const M3_LABELS = {
  M3_UR: 'Upper-Right',
  M3_UL: 'Upper-Left',
  M3_LL: 'Lower-Left',
  M3_LR: 'Lower-Right',
};

// Pathology joined onto this tooth from the segmentation model. Same palette as
// the Detection tab so a finding reads identically in both places.
const FINDING_COLORS = {
  Caries: '#ef4444',
  'Periapical lesion': '#f97316',
  'impacted tooth': '#f59e0b',
  'Retained root': '#e11d48',
  'Root Piece': '#e11d48',
};

function colorFor(det) {
  return M3_COLORS[det.class_name] || TOOTH_COLOR;
}

export default function M3Viewer({
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

  // Which of the four this model actually found. Absence is clinically real —
  // wisdom teeth are the most commonly missing teeth — so the legend below
  // reports found vs not-found rather than silently omitting them.
  const foundClasses = useMemo(
    () => new Set(all.filter((d) => d.is_third_molar).map((d) => d.class_name)),
    [all],
  );

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
          minHeight: { xs: 260, sm: 420 },
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
                Locating wisdom teeth…
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
              aria-label="Panoramic radiograph with identified wisdom teeth"
              sx={{
                display: 'block',
                width: '100%',
                maxHeight: { xs: '60dvh', md: '68dvh' },
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
                    strokeWidth={(isHovered ? 6 : det.is_third_molar ? 4 : 2) * unit}
                    onMouseEnter={() => onHover?.(det.id)}
                    onMouseLeave={() => onHover?.(null)}
                    style={{ cursor: 'pointer', transition: 'stroke-width 0.15s ease-out' }}
                  />
                );
              })}

              {/*
                Only wisdom teeth are numbered. The plain 'Tooth' class carries
                no identity in this model, so labelling those boxes would assert
                a number the model never predicted.
              */}
              {visible.filter((d) => d.is_third_molar && d.fdi_number).map((det) => {
                const color = colorFor(det);
                const [x1, y1, x2] = det.bbox;
                const cx = (x1 + x2) / 2;
                const fontSize = 34 * unit;
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
                      fill={color} rx={3 * unit} fillOpacity={1}
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

              {/* Hovered tooth only: quadrant, confidence, and joined findings. */}
              {visible.filter((det) => det.id === hoveredId).map((det) => {
                const [x1, y1, x2, y2] = det.bbox;
                const cx = (x1 + x2) / 2;
                const parts = [];
                if (M3_LABELS[det.class_name]) parts.push(M3_LABELS[det.class_name]);
                parts.push(`${(det.confidence * 100).toFixed(0)}%`);
                (det.findings || []).forEach((f) => parts.push(f.class_name));
                const label = parts.join(' · ');

                const fontSize = 26 * unit;
                const boxW = label.length * fontSize * 0.58 + 16 * unit;
                const boxH = fontSize * 1.5;
                const boxY = y2 + 8 * unit;
                const boxX = Math.min(Math.max(cx - boxW / 2, 0), size.w - boxW);
                const firstFinding = (det.findings || [])[0]?.class_name;
                const bg = FINDING_COLORS[firstFinding] || '#1e293b';

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
              Wisdom teeth ({thirdMolarCount})
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

        {/*
          All four are always listed. A wisdom tooth the model did not find is
          shown greyed rather than omitted, because "not present" is a real and
          common finding and an absent legend row would read as an oversight.
        */}
        <Stack sx={{ flexWrap: 'wrap' }} direction="row" spacing={0.75} useFlexGap>
          {Object.entries(M3_LABELS).map(([cls, label]) => {
            const found = foundClasses.has(cls);
            const color = found ? M3_COLORS[cls] : TOOTH_COLOR;
            return (
              <Chip
                key={cls}
                size="small"
                label={found ? label : `${label} — not found`}
                sx={{
                  height: 24,
                  fontSize: '0.7rem',
                  opacity: found ? 1 : 0.6,
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
            );
          })}
        </Stack>
      </Stack>
    </Box>
  );
}
