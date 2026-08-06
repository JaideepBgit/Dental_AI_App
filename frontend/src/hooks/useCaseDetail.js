/**
 * Owns one case: its data, the doctor's in-progress decisions, and sign-off.
 *
 * Three models write into a single detections list tagged by `source`. Splitting
 * them is this hook's job, not the viewer's, so each tab renders only its own
 * model's rows. Rows stored before `source` existed default to 'detect'.
 *
 * Validation lives here rather than in the page: approve() returns
 * {ok, message} so any caller enforces the same rules.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../services/apiClient';

export function useCaseDetail({ api = apiClient, xrayId } = {}) {
  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // The HTTP status alongside the message: 403 (not yours) and 404 (no such case)
  // are expected outcomes the page explains differently from a real failure.
  const [errorStatus, setErrorStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const [extractionIds, setExtractionIds] = useState([]);
  const [prescriptionText, setPrescriptionText] = useState('');
  const [decision, setDecision] = useState('');
  // The raw dictation is kept apart from prescriptionText so the transcript stays
  // auditable even after the clinician edits the note.
  const [dictationText, setDictationText] = useState('');
  // Stamped when the case is first loaded, so the record can distinguish when it
  // was reviewed from when it was signed.
  const [reviewedAt, setReviewedAt] = useState(null);
  const [amendsId, setAmendsId] = useState(null);

  const applyCase = useCallback((data) => {
    setCaseData(data);
    // Restore prior decisions on an already-signed case; otherwise start clean.
    setExtractionIds(
      (data.detections || []).filter((d) => d.needs_extraction).map((d) => d.id),
    );
    setPrescriptionText(
      data.prescription?.prescription_text || data.referral?.prescription_text || '',
    );
    setDecision(data.prescription?.decision || '');
    setDictationText('');
    setAmendsId(null);
  }, []);

  useEffect(() => {
    if (!xrayId) {
      setCaseData(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorStatus(null);

    api.fetchXray(xrayId)
      .then((data) => {
        if (cancelled) return;
        applyCase(data);
        setReviewedAt(new Date().toISOString());
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setErrorStatus(err.status || null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [api, xrayId, applyCase]);

  const toggleExtraction = useCallback((detId) => {
    setExtractionIds((prev) =>
      (prev.includes(detId) ? prev.filter((i) => i !== detId) : [...prev, detId]));
  }, []);

  const reload = useCallback(async () => {
    if (!xrayId) return;
    try {
      applyCase(await api.fetchXray(xrayId));
      setError(null);
      setErrorStatus(null);
    } catch (err) {
      setError(err.message);
      setErrorStatus(err.status || null);
    }
  }, [api, xrayId, applyCase]);

  /**
   * Sign the case.
   *
   * There is no doctorName argument: the signing clinician comes from the
   * authenticated session on the server, so the client cannot claim an identity.
   */
  const approve = useCallback(async ({ signature }) => {
    if (!caseData) return { ok: false, message: 'No case loaded.' };
    if (!decision) {
      return { ok: false, message: 'Choose a clinical decision.' };
    }
    if (!prescriptionText.trim()) {
      return { ok: false, message: 'Dictate or type a prescription note.' };
    }
    if (!signature) {
      return { ok: false, message: 'Please sign before approving.' };
    }
    // Mirrors the server rule, so the clinician is told before the round trip.
    if (decision === 'NO_ACTION_NEEDED' && extractionIds.length > 0) {
      return {
        ok: false,
        message: '"No action needed" cannot be combined with teeth marked for extraction.',
      };
    }

    setSaving(true);
    try {
      const result = await api.approveCase({
        xrayId: caseData.id,
        decision,
        prescriptionText,
        signature,
        extractionIds,
        dictationText: dictationText || undefined,
        reviewedAt: reviewedAt || undefined,
        amendsId: amendsId || undefined,
      });
      await reload();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, message: err.message };
    } finally {
      setSaving(false);
    }
  }, [api, caseData, decision, prescriptionText, extractionIds, dictationText,
      reviewedAt, amendsId, reload]);

  /** Begin an amendment: the prior record is preserved and marked superseded. */
  const startAmendment = useCallback(() => {
    if (!caseData?.prescription) return;
    setAmendsId(caseData.prescription.id);
  }, [caseData]);

  // Depend on caseData.detections rather than on a `|| []` fallback: the
  // fallback is a fresh array identity every render, which would defeat every
  // useMemo below.
  const allDetections = caseData?.detections;

  const toothDetections = useMemo(
    () => (allDetections || []).filter((d) => (d.source || 'detect') === 'detect'),
    [allDetections],
  );
  const segDetections = useMemo(
    () => (allDetections || []).filter((d) => d.source === 'segment'),
    [allDetections],
  );
  const hierDetections = useMemo(
    () => (allDetections || []).filter((d) => d.source === 'hier'),
    [allDetections],
  );

  // Findings with a real traced mask, as opposed to a bounding box stored
  // before the segmentation model was installed.
  const maskCount = useMemo(
    () => segDetections.filter((d) => d.polygon && d.polygon.length >= 3).length,
    [segDetections],
  );
  const hierThirdMolars = useMemo(
    () => hierDetections.filter((d) => d.is_third_molar).length,
    [hierDetections],
  );

  return {
    caseData, loading, error, errorStatus, saving,
    extractionIds, toggleExtraction,
    prescriptionText, setPrescriptionText,
    decision, setDecision,
    dictationText, setDictationText,
    amendsId, startAmendment,
    approve, reload,
    toothDetections, segDetections, hierDetections,
    maskCount, hierThirdMolars,
    prescription: caseData?.prescription || null,
    prescriptionHistory: caseData?.prescription_history || [],
    isApproved: caseData?.status === 'APPROVED',
    isPending: caseData?.status === 'PENDING',
  };
}
