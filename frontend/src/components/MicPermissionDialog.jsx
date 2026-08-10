/**
 * The microphone gate for dictation.
 *
 * Dictation used to fail with a one-line error and no way forward. This walks the
 * clinician through it instead: ask the browser for permission, show which input
 * device will be used, prove the mic is picking up sound with a live level meter,
 * and — when the browser has blocked it — say exactly which buttons to press in
 * the browser they are actually using.
 *
 * The HTTP case is called out first because it is not a permission problem at
 * all: over plain http:// to a LAN IP, navigator.mediaDevices is undefined, so
 * there is no prompt to trigger and no amount of clicking Allow will help. That
 * needs an origin change (localhost or https), which only the deployment can fix,
 * so the dialog explains it rather than pretending a retry might work.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, LinearProgress, MenuItem, Stack, TextField,
  Typography,
} from '@mui/material';
import MicIcon from '@mui/icons-material/Mic';
import CheckIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import LockIcon from '@mui/icons-material/HttpsOutlined';

/**
 * Browsers expose mediaDevices only in a secure context: https, or http on
 * localhost/127.0.0.1. Over plain http to a LAN IP the property is undefined
 * rather than merely unpermitted, so recording cannot start at all.
 */
export const micApiAvailable = () =>
  typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

/** True when the page origin is one the browser treats as secure. */
export const isSecureOrigin = () => {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

/** Which browser family we are in, for accurate unblocking instructions. */
function detectBrowser() {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Chrome\//.test(ua) && !/Edg\/|OPR\//.test(ua)) return 'chrome';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'safari';
  return 'other';
}

/** Per-browser steps to clear a blocked mic permission. */
const UNBLOCK_STEPS = {
  chrome: [
    'Click the icon at the left of the address bar (a slider, lock or camera icon).',
    'Find "Microphone" and set it to Allow.',
    'Reload this page, then press Dictate again.',
  ],
  edge: [
    'Click the lock or permissions icon at the left of the address bar.',
    'Set "Microphone" to Allow.',
    'Reload this page, then press Dictate again.',
  ],
  opera: [
    'Click the icon at the left of the address bar.',
    'Set "Microphone" to Allow.',
    'Reload this page, then press Dictate again.',
  ],
  firefox: [
    'Click the microphone or permissions icon in the address bar.',
    'Remove the "Blocked" setting for microphone.',
    'Reload this page, then press Dictate again.',
  ],
  safari: [
    'Open Safari > Settings > Websites > Microphone.',
    'Set this site to Allow.',
    'Reload this page, then press Dictate again.',
  ],
  other: [
    'Open your browser\'s site permissions for this page.',
    'Set Microphone to Allow.',
    'Reload this page, then press Dictate again.',
  ],
};

/**
 * @param open        whether the dialog is shown
 * @param onClose     dismiss without granting
 * @param onGranted   called with the chosen deviceId once permission is live
 */
export default function MicPermissionDialog({ open, onClose, onGranted }) {
  // 'checking' | 'insecure' | 'prompt' | 'granted' | 'denied' | 'nodevice' | 'error'
  const [state, setState] = useState('checking');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [level, setLevel] = useState(0);
  const [detail, setDetail] = useState(null);

  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const rafRef = useRef(null);

  const browser = detectBrowser();

  /** Tear down the mic, the meter and the audio graph. */
  const stopProbe = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    // close() returns a promise that rejects if already closed; nothing to do.
    audioCtxRef.current?.close?.().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  };

  useEffect(() => stopProbe, []);

  // Release the mic as soon as the dialog closes: holding it would leave the
  // browser's recording indicator lit with nothing recording.
  useEffect(() => {
    if (!open) stopProbe();
  }, [open]);

  /** Label the device list once permission exists (labels are hidden before that). */
  const refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === 'audioinput');
      setDevices(inputs);
      return inputs;
    } catch {
      return [];
    }
  };

  /** Drive the live level meter, so a muted or dead mic is visible immediately. */
  const startMeter = (stream) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        // Peak deviation from silence (128), scaled to 0-100.
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          peak = Math.max(peak, Math.abs(data[i] - 128));
        }
        setLevel(Math.min(100, Math.round((peak / 128) * 140)));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // A missing AudioContext costs the meter, not the permission.
    }
  };

  /**
   * Ask the browser for the mic. This is the call that raises the native prompt,
   * and it must run from a user gesture, which is why the dialog has an explicit
   * button rather than requesting on mount.
   */
  const requestAccess = async (preferredId) => {
    setDetail(null);

    if (!isSecureOrigin() || !micApiAvailable()) {
      setState('insecure');
      return;
    }

    setState('checking');
    stopProbe();
    try {
      const constraints = {
        audio: preferredId ? { deviceId: { exact: preferredId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const inputs = await refreshDevices();
      // Track what was actually granted, which need not be what was asked for.
      const activeId = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
      setDeviceId(preferredId || activeId || inputs[0]?.deviceId || '');

      startMeter(stream);
      setState('granted');
    } catch (err) {
      setDetail(err?.message || String(err));
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
        setState('denied');
      } else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        setState('nodevice');
      } else {
        setState('error');
      }
    }
  };

  // On open, work out where we stand without triggering a prompt: the Permissions
  // API answers "already granted / already denied" silently, so an
  // already-permitted clinician is not asked twice.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      if (!isSecureOrigin() || !micApiAvailable()) {
        if (!cancelled) setState('insecure');
        return;
      }
      try {
        const status = await navigator.permissions?.query({ name: 'microphone' });
        if (cancelled) return;
        if (status?.state === 'granted') {
          requestAccess();
          return;
        }
        if (status?.state === 'denied') {
          setState('denied');
          return;
        }
        setState('prompt');
      } catch {
        // Firefox and Safari may not support querying 'microphone'. Offering the
        // button is correct there: getUserMedia is the real source of truth.
        if (!cancelled) setState('prompt');
      }
    })();

    return () => { cancelled = true; };
  }, [open]);

  const switchDevice = (nextId) => {
    setDeviceId(nextId);
    requestAccess(nextId);
  };

  const confirm = () => {
    // Hand the choice up, then release our own probe stream — VoiceDictator opens
    // its own when recording actually starts.
    stopProbe();
    onGranted?.(deviceId || undefined);
  };

  const host = typeof window !== 'undefined' ? window.location.host : '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <MicIcon fontSize="small" />
        Turn on the microphone
      </DialogTitle>

      <DialogContent>
        {state === 'checking' && (
          <Stack spacing={2} sx={{ alignItems: 'center', py: 3 }}>
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary">
              Checking microphone access…
            </Typography>
          </Stack>
        )}

        {state === 'prompt' && (
          <Stack spacing={2}>
            <Typography variant="body2">
              Dictation needs your microphone. Press the button below — your browser
              will ask for permission, and you should choose <strong>Allow</strong>.
            </Typography>
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              The prompt appears at the top of the browser window, usually just
              under the address bar. It only appears once per browser.
            </Alert>
            <Button
              variant="contained"
              size="large"
              startIcon={<MicIcon />}
              onClick={() => requestAccess()}
              disableElevation
            >
              Allow microphone access
            </Button>
          </Stack>
        )}

        {state === 'granted' && (
          <Stack spacing={2.5}>
            <Alert severity="success" icon={<CheckIcon fontSize="small" />} sx={{ borderRadius: 2 }}>
              Microphone is on. Speak now — the bar below should move.
            </Alert>

            <Box>
              <Stack
                direction="row"
                sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}
              >
                <Typography variant="body2" color="text.secondary">Input level</Typography>
                <Chip
                  size="small"
                  label={level > 6 ? 'Picking up sound' : 'Silent'}
                  color={level > 6 ? 'success' : 'default'}
                  sx={{ height: 20, fontSize: '0.7rem' }}
                />
              </Stack>
              <LinearProgress
                variant="determinate"
                value={level}
                sx={{
                  height: 10, borderRadius: 5,
                  '& .MuiLinearProgress-bar': {
                    transition: 'transform 80ms linear',
                    bgcolor: level > 6 ? 'success.main' : 'grey.400',
                  },
                }}
              />
              {level <= 6 && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                  No sound yet. Check the mic is not muted in hardware, or pick a
                  different input below.
                </Typography>
              )}
            </Box>

            {devices.length > 0 && (
              <TextField
                select
                size="small"
                fullWidth
                label="Microphone"
                value={deviceId}
                onChange={(e) => switchDevice(e.target.value)}
                helperText="Choose which input to dictate through."
              >
                {devices.map((d, i) => (
                  <MenuItem key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Stack>
        )}

        {state === 'denied' && (
          <Stack spacing={2}>
            <Alert severity="warning" icon={<BlockIcon fontSize="small" />} sx={{ borderRadius: 2 }}>
              Your browser has blocked the microphone for this site. It will not ask
              again until you clear that yourself.
            </Alert>
            <Typography variant="subtitle2">
              To unblock it in {browser === 'other' ? 'your browser' : browser}:
            </Typography>
            <Stack component="ol" spacing={1} sx={{ pl: 2.5, m: 0 }}>
              {UNBLOCK_STEPS[browser].map((step) => (
                <Typography key={step} component="li" variant="body2">{step}</Typography>
              ))}
            </Stack>
            <Button variant="outlined" onClick={() => requestAccess()}>
              I have allowed it — try again
            </Button>
            {detail && (
              <Typography variant="caption" color="text.secondary">
                Browser reported: {detail}
              </Typography>
            )}
          </Stack>
        )}

        {state === 'insecure' && (
          <Stack spacing={2}>
            <Alert severity="error" icon={<LockIcon fontSize="small" />} sx={{ borderRadius: 2 }}>
              This page is served over plain HTTP (<code>{host}</code>), and browsers
              only allow microphone access on a secure origin. There is no permission
              prompt to accept — the microphone API is not available at all here.
            </Alert>
            <Typography variant="subtitle2">Ways to dictate right now:</Typography>
            <Stack component="ul" spacing={1} sx={{ pl: 2.5, m: 0 }}>
              <Typography component="li" variant="body2">
                Open the app on the machine running it, at{' '}
                <strong>http://localhost:8000</strong> — localhost counts as secure,
                so the mic works with no other change.
              </Typography>
              <Typography component="li" variant="body2">
                Or forward the port to your own machine and use localhost there:
                <Box component="code" sx={{ display: 'block', mt: 0.5, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: '0.75rem' }}>
                  ssh -L 8000:localhost:8000 user@{host.split(':')[0]}
                </Box>
              </Typography>
              <Typography component="li" variant="body2">
                For everyday use on the practice network, serve the app over HTTPS.
                That is a one-time deployment change and fixes this for every
                clinician.
              </Typography>
            </Stack>
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              You can still type the prescription note by hand — sign-off is not
              blocked by this.
            </Alert>
          </Stack>
        )}

        {state === 'nodevice' && (
          <Stack spacing={2}>
            <Alert severity="warning" sx={{ borderRadius: 2 }}>
              No microphone was found. Plug in a headset or check your system sound
              settings, then try again.
            </Alert>
            <Button variant="outlined" onClick={() => requestAccess()}>Try again</Button>
          </Stack>
        )}

        {state === 'error' && (
          <Stack spacing={2}>
            <Alert severity="error" sx={{ borderRadius: 2 }}>
              Could not start the microphone{detail ? `: ${detail}` : '.'}
            </Alert>
            <Button variant="outlined" onClick={() => requestAccess()}>Try again</Button>
          </Stack>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">
          {state === 'granted' ? 'Cancel' : 'Close'}
        </Button>
        {state === 'granted' && (
          <Button variant="contained" onClick={confirm} disableElevation startIcon={<MicIcon />}>
            Start dictating
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
