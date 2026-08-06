/**
 * Drives the intake submit.
 *
 * Upload returns 202 immediately and detection runs in the background, so this
 * hook owns the two-step flow: post the file, then poll the case until it
 * leaves PENDING. Status moves idle -> uploading -> analysing -> done | error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/apiClient';

const DEFAULT_POLL_MS = 1500;
// 120 polls at 1.5s is three minutes -- longer than any panoramic should take
// through three models, short enough that a wedged case surfaces to the user.
const DEFAULT_MAX_POLLS = 120;

export function useUpload({
  api = apiClient,
  pollIntervalMs = DEFAULT_POLL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
} = {}) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [xrayId, setXrayId] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Guards against a poll loop writing state after the component unmounts,
  // which happens whenever the user navigates away mid-analysis.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setProgress(0);
    setXrayId(null);
    setError(null);
    setResult(null);
  }, []);

  const submit = useCallback(async ({ file, patientName, mrn, appointmentDate }) => {
    setStatus('uploading');
    setProgress(0);
    setError(null);
    setResult(null);

    let created;
    try {
      created = await api.uploadXray({
        file, patientName, mrn, appointmentDate,
        onProgress: (pct) => activeRef.current && setProgress(pct),
      });
    } catch (err) {
      if (activeRef.current) {
        setStatus('error');
        setError(err.message);
      }
      return { ok: false, message: err.message };
    }

    if (!activeRef.current) return { ok: false, message: 'cancelled' };

    const id = created.xray_id;
    setXrayId(id);
    setProgress(100);
    setStatus('analysing');

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      let caseData;
      try {
        caseData = await api.fetchXray(id);
      } catch {
        // A single failed poll is not fatal -- the backend may be busy running
        // inference. Keep waiting; the attempt budget bounds the loop.
        await sleep(pollIntervalMs);
        continue;
      }

      if (!activeRef.current) return { ok: false, message: 'cancelled' };

      if (caseData.status === 'ERROR') {
        const message = caseData.error_message || 'Detection failed for this image.';
        setStatus('error');
        setError(message);
        return { ok: false, message, xrayId: id };
      }

      if (caseData.status && caseData.status !== 'PENDING') {
        setResult(caseData);
        setStatus('done');
        return { ok: true, xrayId: id, caseData };
      }

      await sleep(pollIntervalMs);
    }

    const message = 'This image is still processing. It will appear in the queue when it finishes.';
    if (activeRef.current) {
      setStatus('error');
      setError(message);
    }
    return { ok: false, message, xrayId: id };
  }, [api, pollIntervalMs, maxPolls]);

  return {
    status, progress, xrayId, error, result,
    submit, reset,
    isBusy: status === 'uploading' || status === 'analysing',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
