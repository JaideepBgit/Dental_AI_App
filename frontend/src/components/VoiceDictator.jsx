import { useEffect, useRef, useState } from 'react';
import {
  Box, Button, TextField, Typography, Stack, IconButton, Tooltip,
  CircularProgress, Chip,
} from '@mui/material';
import Mic from '@mui/icons-material/Mic';
import StopIcon from '@mui/icons-material/Stop';
import ClearIcon from '@mui/icons-material/Clear';
import SettingsIcon from '@mui/icons-material/Tune';
import { useApi } from '../services/ApiProvider';
import MicPermissionDialog, { micApiAvailable, isSecureOrigin }
  from './MicPermissionDialog';

const browserSpeechSupported = () =>
  typeof window !== 'undefined' &&
  ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

/**
 * Dictation with two backends.
 *
 * Preferred: record locally, POST to /api/transcribe, transcribe with Whisper
 * on the server. Patient audio stays inside the deployment.
 *
 * Fallback: the browser Web Speech API, used only if the server has no Whisper.
 * That path sends audio to the browser vendor's cloud, so it warns the user.
 */
export default function VoiceDictator({ text, setText, whisperReady, disabled }) {
  const api = useApi();
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [mode, setMode] = useState(null); // 'whisper' | 'browser'
  const [error, setError] = useState(null);
  // The permission walk-through. Opened instead of showing a dead-end error, so
  // "the mic is blocked" always comes with a way to fix it.
  const [micDialogOpen, setMicDialogOpen] = useState(false);
  // Which input the clinician chose in the dialog. Undefined means browser default.
  const [micDeviceId, setMicDeviceId] = useState(undefined);
  // Set once permission has been confirmed this session, so the dialog is not
  // re-shown before every recording.
  const [micReady, setMicReady] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const streamRef = useRef(null);

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Release the microphone if this unmounts mid-recording.
  useEffect(() => () => {
    try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    releaseMic();
  }, []);

  const appendText = (addition) => {
    const clean = (addition || '').trim();
    if (!clean) return;
    setText((prev) => (prev ? `${prev} ${clean}` : clean));
  };

  const startWhisper = async () => {
    // Honour the device picked in the permission dialog. `ideal` rather than
    // `exact` so a mic unplugged since then falls back to the default instead of
    // failing the whole recording.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true,
    });
    streamRef.current = stream;
    chunksRef.current = [];

    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      releaseMic();
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (blob.size === 0) return;

      setIsTranscribing(true);
      try {
        appendText(await api.transcribeAudio(blob));
      } catch (err) {
        if (err.unavailable && browserSpeechSupported()) {
          setError('Server transcription unavailable — retry to use browser dictation.');
          setMode('browser');
        } else {
          setError(err.message);
        }
      } finally {
        setIsTranscribing(false);
      }
    };

    recorder.start();
    mediaRecorderRef.current = recorder;
    setMode('whisper');
    setIsRecording(true);
  };

  const startBrowser = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) finalText += `${event.results[i][0].transcript} `;
      }
      appendText(finalText);
    };
    recognition.onerror = (event) => {
      setError(`Dictation error: ${event.error}`);
      setIsRecording(false);
    };
    recognition.onend = () => setIsRecording(false);

    recognition.start();
    recognitionRef.current = recognition;
    setMode('browser');
    setIsRecording(true);
  };

  const stop = () => {
    if (mode === 'whisper') {
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
    } else {
      try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    }
    setIsRecording(false);
  };

  /** Begin capturing, assuming permission is already in hand. */
  const beginCapture = async () => {
    setError(null);
    // Prefer the server path; only fall back when Whisper genuinely isn't there.
    // Recording also needs the mic API, which an insecure origin withholds.
    const useWhisper = whisperReady && mode !== 'browser' && micApiAvailable();
    try {
      if (useWhisper) {
        await startWhisper();
      } else if (browserSpeechSupported()) {
        startBrowser();
      } else {
        setError('No dictation available. Install Whisper on the server, or use Chrome/Edge.');
      }
    } catch (err) {
      releaseMic();
      setIsRecording(false);
      // Anything permission-shaped goes back to the dialog, which can actually
      // explain it, rather than being flattened into a one-line error.
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
          || err?.name === 'NotFoundError') {
        setMicReady(false);
        setMicDialogOpen(true);
        return;
      }
      setError(`Could not start recording: ${err.message}`);
    }
  };

  const start = async () => {
    setError(null);

    // Nothing to permit on an insecure origin -- getUserMedia does not exist
    // there. Open the dialog, which explains why and what to do instead.
    if (!micApiAvailable() || !isSecureOrigin()) {
      // The browser Web Speech API can still work on some browsers over http,
      // so try it before declaring dictation impossible.
      if (browserSpeechSupported()) {
        try {
          startBrowser();
          return;
        } catch {
          // fall through to the dialog
        }
      }
      setMicDialogOpen(true);
      return;
    }

    // First use in this session: walk through permission, device choice and a
    // level check before recording anything.
    if (!micReady) {
      setMicDialogOpen(true);
      return;
    }

    await beginCapture();
  };

  /** The dialog confirmed access; remember the device and start recording. */
  const handleMicGranted = async (chosenDeviceId) => {
    setMicDeviceId(chosenDeviceId);
    setMicReady(true);
    setMicDialogOpen(false);
    await beginCapture();
  };

  const busy = isTranscribing || disabled;

  return (
    <Box sx={{ width: '100%' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5, minHeight: 32 }}
      >
        <Stack sx={{ alignItems: 'center' }} direction="row" spacing={0.75}>
          <Typography variant="subtitle1">Prescription note</Typography>
          {mode === 'browser' && (
            <Tooltip title="Browser dictation sends audio to your browser vendor's servers. Install Whisper on the backend to keep audio local.">
              <Chip label="browser" size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
            </Tooltip>
          )}
          {mode === 'whisper' && (
            <Tooltip title="Transcribed locally by Whisper — audio does not leave the server">
              <Chip
                label="local"
                size="small"
                sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'healthy.light', color: '#065f46' }}
              />
            </Tooltip>
          )}
        </Stack>

        <Stack sx={{ alignItems: 'center' }} direction="row" spacing={0.5}>
          {text && !isRecording && (
            <Tooltip title="Clear note">
              <IconButton
                size="small"
                onClick={() => setText('')}
                disabled={busy}
                sx={{ color: 'text.secondary' }}
              >
                <ClearIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {/* Always reachable, so a clinician can switch headsets or re-check the
              mic without having to hit an error first. */}
          {!isRecording && (
            <Tooltip title="Microphone settings">
              <IconButton
                size="small"
                onClick={() => setMicDialogOpen(true)}
                disabled={busy}
                sx={{ color: 'text.secondary' }}
              >
                <SettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Button
            variant="outlined"
            size="small"
            disabled={busy}
            startIcon={
              isTranscribing ? <CircularProgress size={14} thickness={5} />
                : isRecording ? <StopIcon fontSize="small" />
                  : <Mic fontSize="small" />
            }
            onClick={isRecording ? stop : start}
            sx={{
              flexShrink: 0,
              animation: isRecording ? 'pulse 2s infinite' : 'none',
              ...(isRecording && {
                bgcolor: '#fef2f2',
                borderColor: '#fca5a5',
                color: '#dc2626',
                '&:hover': { bgcolor: '#fee2e2', borderColor: '#f87171' },
              }),
            }}
          >
            {isTranscribing ? 'Transcribing…' : isRecording ? 'Stop' : 'Dictate'}
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Typography variant="caption" sx={{ color: 'impacted.main', display: 'block', mb: 1 }}>
          {error}
        </Typography>
      )}

      <TextField
        multiline
        fullWidth
        minRows={5}
        maxRows={12}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Dictate or type the prescription and referral instructions…"
        variant="outlined"
      />

      <MicPermissionDialog
        open={micDialogOpen}
        onClose={() => setMicDialogOpen(false)}
        onGranted={handleMicGranted}
      />
    </Box>
  );
}
