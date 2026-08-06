import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, Chip, Stack, Slider } from '@mui/material';

/**
 * Polygon-mask viewer for the YOLO-seg model.
 *
 * Geometry follows the same rule as Viewer.jsx: the radiograph is an <image>
 * INSIDE the SVG, not a DOM <img> with the SVG positioned over it. One viewBox
 * means one coordinate system, so masks cannot drift away from the anatomy when
 * height is the binding constraint (a wide panoramic in a narrow column).
 */

// Findings are grouped by clinical meaning rather than given 12 arbitrary hues:
// a doctor scanning the image should be able to read severity from colour alone.
const CLASS_COLORS = {
  'caries': '#ef4444',              // pathology — red
  'periapical lesion': '#f97316',
  'impacted tooth': '#f59e0b',      // needs a decision — amber
  'root piece': '#eab308',
  'retained root': '#eab308',
  'missing teeth': '#a855f7',       // absent structure — violet
  'crown': '#38bdf8',               // existing restoration — blue
  'filling': '#22d3ee',
  'implant': '#2dd4bf',
  'root canal treatment': '#818cf8',
  'mandibular canal': '#4ade80',    // normal anatomy — green
  'maxillary sinus': '#84cc16',
};

const COLOR_FALLBACK = '#94a3b8';

function colorForClass(className) {
  return CLASS_COLORS[(className || '').toLowerCase()] || COLOR_FALLBACK;
}

export default function SegmentationViewer({ imageUrl, detections, isAnalyzing, hoveredId, onHover }) {
  const [size, setSize] = useState(null);
  const [failed, setFailed] = useState(false);
  const [minConf, setMinConf] = useState(0.25);
  const [hiddenClasses, setHiddenClasses] = useState([]);
  const imgRef = useRef(null);

  useEffect(() => {
    setSize(null);
    setFailed(false);
  }, [imageUrl]);

  // Memoised on `detections` itself, not on a defaulted copy: `detections || []`
  // would be a new array identity every render and defeat the memo.
  const all = useMemo(() => detections || [], [detections]);

  // Class list comes from what this image actually contains, with counts, so the
  // legend doubles as a per-class filter.
  const classes = useMemo(() => {
    const counts = new Map();
    all.forEach((d) => {
      counts.set(d.class_name, (counts.get(d.class_name) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  const visible = all.filter(
    (d) => d.confidence >= minConf && !hiddenClasses.includes(d.class_name),
  );

  const withMask = visible.filter((d) => d.polygon && d.polygon.length >= 3).length;

  // Scale strokes/text to image width so a 3000px and an 800px panoramic look
  // the same on screen.
  const unit = size ? size.w / 2000 : 1;

  const toggleClass = (name) => {
    setHiddenClasses((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]);
  };

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
                Running segmentation…
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
              aria-label="Panoramic radiograph with segmented findings"
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

              {/*
                Masks are drawn in two passes: every fill first, then every
                outline. Findings overlap constantly on a panoramic (a filling
                sits inside a crown), and a single pass would let one finding's
                translucent fill wash out the outline of the one beneath it.
              */}
              {visible.map((det) => {
                const color = colorForClass(det.class_name);
                const isHovered = hoveredId === det.id;
                const hasPolygon = det.polygon && det.polygon.length >= 3;

                const shared = {
                  fill: color,
                  fillOpacity: isHovered ? 0.42 : 0.18,
                  stroke: 'none',
                  style: { pointerEvents: 'none', transition: 'fill-opacity 0.15s ease-out' },
                };

                if (hasPolygon) {
                  return (
                    <polygon
                      key={`fill-${det.id}`}
                      points={det.polygon.map(([x, y]) => `${x},${y}`).join(' ')}
                      {...shared}
                    />
                  );
                }
                const [x1, y1, x2, y2] = det.bbox;
                return (
                  <rect
                    key={`fill-${det.id}`}
                    x={x1} y={y1} width={x2 - x1} height={y2 - y1}
                    rx={4 * unit}
                    {...shared}
                  />
                );
              })}

              {visible.map((det) => {
                const color = colorForClass(det.class_name);
                const isHovered = hoveredId === det.id;
                const hasPolygon = det.polygon && det.polygon.length >= 3;

                const shared = {
                  fill: 'none',
                  stroke: color,
                  strokeWidth: (isHovered ? 6 : 3) * unit,
                  // Dashed outline flags a bbox fallback: the mask is an
                  // approximation, not a traced boundary.
                  strokeDasharray: hasPolygon ? undefined : `${10 * unit} ${7 * unit}`,
                  onMouseEnter: () => onHover?.(det.id),
                  onMouseLeave: () => onHover?.(null),
                  style: { cursor: 'pointer', transition: 'stroke-width 0.15s ease-out' },
                };

                if (hasPolygon) {
                  return (
                    <polygon
                      key={`line-${det.id}`}
                      points={det.polygon.map(([x, y]) => `${x},${y}`).join(' ')}
                      {...shared}
                    />
                  );
                }
                const [x1, y1, x2, y2] = det.bbox;
                return (
                  <rect
                    key={`line-${det.id}`}
                    x={x1} y={y1} width={x2 - x1} height={y2 - y1}
                    rx={4 * unit}
                    {...shared}
                  />
                );
              })}

              {/*
                Only the hovered finding gets a label. With up to 40 overlapping
                masks on one panoramic, always-on labels cover the anatomy the
                doctor is trying to read.
              */}
              {visible
                .filter((det) => det.id === hoveredId)
                .map((det) => {
                  const color = colorForClass(det.class_name);
                  const [x1, y1, x2] = det.bbox;
                  const cx = (x1 + x2) / 2;

                  const label = `${det.class_name} · ${(det.confidence * 100).toFixed(0)}%`;
                  const fontSize = 30 * unit;
                  const boxW = label.length * fontSize * 0.58 + 16 * unit;
                  const boxH = fontSize * 1.5;

                  // Sit above the finding, flipping below when there's no room,
                  // and stay inside the frame horizontally.
                  const above = y1 - boxH - 8 * unit > 0;
                  const boxY = above ? y1 - boxH - 8 * unit : y1 + 8 * unit;
                  const boxX = Math.min(Math.max(cx - boxW / 2, 0), size.w - boxW);

                  return (
                    <g key={`label-${det.id}`} style={{ pointerEvents: 'none' }}>
                      <rect
                        x={boxX} y={boxY} width={boxW} height={boxH}
                        fill={color} rx={4 * unit}
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

      {/* Controls: confidence floor + per-class visibility */}
      <Stack spacing={1.5} sx={{ mt: 2 }}>
        <Stack sx={{ alignItems: 'center' }} direction="row" spacing={2}>
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
            sx={{ maxWidth: 220 }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
            {visible.length} of {all.length} shown
            {visible.length > 0 && withMask < visible.length
              && ` · ${visible.length - withMask} box-only`}
          </Typography>
        </Stack>

        {classes.length > 0 && (
          <Stack sx={{ flexWrap: 'wrap' }} direction="row" spacing={0.75} useFlexGap>
            {classes.map(([name, count]) => {
              const off = hiddenClasses.includes(name);
              const color = colorForClass(name);
              return (
                <Chip
                  key={name}
                  size="small"
                  label={`${name} (${count})`}
                  onClick={() => toggleClass(name)}
                  sx={{
                    height: 24,
                    fontSize: '0.7rem',
                    cursor: 'pointer',
                    bgcolor: off ? 'transparent' : `${color}1F`,
                    border: '1px solid',
                    borderColor: off ? 'divider' : `${color}66`,
                    color: off ? 'text.disabled' : 'text.primary',
                    textDecoration: off ? 'line-through' : 'none',
                    '& .MuiChip-label': { px: 0.75 },
                    '&::before': {
                      content: '""',
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: off ? 'transparent' : color,
                      border: off ? `1px solid ${color}` : 'none',
                      ml: 0.75,
                      flexShrink: 0,
                    },
                  }}
                />
              );
            })}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
