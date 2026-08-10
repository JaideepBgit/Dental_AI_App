import { useEffect, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, Chip, Stack } from '@mui/material';

const COLOR_EXTRACT = '#ef4444';
const COLOR_THIRD_MOLAR = '#f59e0b';
const COLOR_OTHER = '#94a3b8';

function colorFor(det, marked) {
  if (marked) return COLOR_EXTRACT;
  if (det.is_third_molar) return COLOR_THIRD_MOLAR;
  return COLOR_OTHER;
}

/**
 * Radiograph with arrow + label overlays, mirroring what the referral PDF
 * renders so the doctor sees on screen what the patient's slip will show.
 *
 * Geometry is done in the image's own pixel space via an SVG viewBox, so the
 * overlay scales with the image without any per-element percentage maths.
 */
export default function Viewer({
  imageUrl, detections, extractionIds, isAnalyzing, hoveredId, onHover, showAll,
}) {
  const [size, setSize] = useState(null);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    setSize(null);
    setFailed(false);
  }, [imageUrl]);

  const handleLoad = (e) => {
    setSize({ w: e.target.naturalWidth, h: e.target.naturalHeight });
  };

  const visible = (detections || []).filter(
    (d) => showAll || d.is_third_molar || extractionIds.includes(d.id),
  );

  // Scale strokes and text to image width so a 3000px panoramic and an 800px
  // one look the same on screen.
  const unit = size ? size.w / 2000 : 1;

  return (
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
      {/*
        The radiograph is rendered as an <image> INSIDE the SVG rather than as a
        DOM <img> with the SVG absolutely positioned over it.

        That earlier arrangement could not be made reliable: the overlay was
        sized by the wrapper, the wrapper was sized by the image, and whenever
        height was the binding constraint (a wide panoramic in a narrow column)
        the two disagreed — so boxes drifted outward, worst at the edges.

        With one SVG there is a single coordinate system. The <image> and every
        box are placed in the same viewBox units, so they cannot desynchronise
        at any container size or aspect ratio.
      */}
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
              Running detection…
            </Typography>
          </Box>
        )}

        {/*
          Hidden probe: reads the intrinsic pixel dimensions so the SVG viewBox
          can be set. The SVG's own <image> does the visible rendering.
        */}
        <img
          ref={imgRef}
          src={imageUrl}
          alt=""
          aria-hidden="true"
          onLoad={handleLoad}
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
            aria-label="Panoramic radiograph with detected teeth"
            sx={{
              display: 'block',
              width: '100%',
              // Bound the height the same way the container did, and let the
              // viewBox letterbox within it. maxHeight on the SVG is safe here
              // because nothing else has to match its box.
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
            <defs>
              {[COLOR_EXTRACT, COLOR_THIRD_MOLAR, COLOR_OTHER].map((c) => (
                <marker
                  key={c}
                  id={`arrow-${c.replace('#', '')}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 z" fill={c} />
                </marker>
              ))}
            </defs>

            {visible.map((det) => {
              const [x1, y1, x2, y2] = det.bbox;
              const marked = extractionIds.includes(det.id);
              const color = colorFor(det, marked);
              const isHovered = hoveredId === det.id;
              const cx = (x1 + x2) / 2;
              const isUpper = (det.quadrant || '').startsWith('Upper');
              const arrowLen = 110 * unit;

              const label = det.fdi_number ? `FDI ${det.fdi_number}` : det.class_name;
              const fullLabel = marked ? `${label} · EXTRACT` : label;
              const fontSize = 30 * unit;
              const boxW = fullLabel.length * fontSize * 0.58 + 16 * unit;
              const boxH = fontSize * 1.4;

              // Everything below is clamped to the image box. An arrow or label
              // placed outside it would be clipped by the viewBox and read as
              // markup floating away from the radiograph.
              const clampY = (v) => Math.min(Math.max(v, boxH), size.h - boxH);

              // Point down at the upper arch, up at the lower, so arrows never
              // cross the opposing teeth. If there isn't room on the preferred
              // side, flip to the other one rather than overflow.
              const roomAbove = y1 - arrowLen - boxH > 0;
              const roomBelow = y2 + arrowLen + boxH < size.h;
              const pointDown = isUpper ? roomAbove || !roomBelow : !roomBelow && roomAbove;

              const tipY = pointDown ? y1 - 6 * unit : y2 + 6 * unit;
              const tailY = clampY(pointDown ? y1 - arrowLen : y2 + arrowLen);
              const labelY = clampY(pointDown ? tailY - 8 * unit : tailY + 22 * unit);

              // Keep the label plate fully inside the frame horizontally.
              const labelCx = Math.min(Math.max(cx, boxW / 2), size.w - boxW / 2);

              return (
                <g
                  key={det.id}
                  onMouseEnter={() => onHover?.(det.id)}
                  onMouseLeave={() => onHover?.(null)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    x={x1}
                    y={y1}
                    width={x2 - x1}
                    height={y2 - y1}
                    fill={isHovered ? `${color}33` : `${color}14`}
                    stroke={color}
                    strokeWidth={(isHovered ? 5 : 3) * unit}
                    rx={4 * unit}
                  />
                  <line
                    x1={cx}
                    y1={tailY}
                    x2={cx}
                    y2={tipY}
                    stroke={color}
                    strokeWidth={4 * unit}
                    markerEnd={`url(#arrow-${color.replace('#', '')})`}
                  />
                  <rect
                    x={labelCx - boxW / 2}
                    y={labelY - fontSize}
                    width={boxW}
                    height={boxH}
                    fill={color}
                    rx={3 * unit}
                  />
                  <text
                    x={labelCx}
                    y={labelY + fontSize * 0.12}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize={fontSize}
                    fontWeight="600"
                    fontFamily="Inter, sans-serif"
                  >
                    {fullLabel}
                  </text>
                </g>
              );
            })}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function ViewerLegend() {
  const entries = [
    ['Marked for extraction', COLOR_EXTRACT],
    ['3rd molar', COLOR_THIRD_MOLAR],
    ['Other tooth', COLOR_OTHER],
  ];
  return (
    <Stack sx={{ flexWrap: 'wrap' }} direction="row" spacing={1} useFlexGap>
      {entries.map(([label, color]) => (
        <Chip
          key={label}
          size="small"
          label={label}
          sx={{
            height: 22,
            fontSize: '0.7rem',
            bgcolor: 'transparent',
            border: '1px solid',
            borderColor: 'divider',
            '& .MuiChip-label': { px: 0.75 },
            '&::before': {
              content: '""',
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: color,
              ml: 0.75,
            },
          }}
        />
      ))}
    </Stack>
  );
}
