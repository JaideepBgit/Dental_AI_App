/**
 * useCases owns the queue: load, filter, search, refresh, retry.
 * useCaseDetail owns one case and its per-case form state.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCases } from '../useCases';
import { useCaseDetail } from '../useCaseDetail';

const ITEMS = [
  { id: 1, patient_name: 'Patient One', mrn: 'MRN-A', status: 'PROCESSED' },
  { id: 2, patient_name: 'Patient Three', mrn: 'MRN-B', status: 'APPROVED' },
  { id: 3, patient_name: 'Patient Two', mrn: 'MRN-C', status: 'ERROR' },
];

function fakeApi(overrides = {}) {
  return {
    fetchQueue: vi.fn(async () => ({ count: ITEMS.length, items: ITEMS })),
    retryXray: vi.fn(async () => ({ status: 'PENDING' })),
    deleteXray: vi.fn(async () => ({ status: 'deleted', deleted_detections: 2 })),
    ...overrides,
  };
}

describe('useCases', () => {
  it('loads the queue on mount', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useCases({ api }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(3);
  });

  it('exposes counts per status for the filter chips', async () => {
    const { result } = renderHook(() => useCases({ api: fakeApi() }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.counts).toMatchObject({
      all: 3, PROCESSED: 1, APPROVED: 1, ERROR: 1,
    });
  });

  it('refetches when the status filter changes', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useCases({ api }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.setStatus('ERROR'); });

    await waitFor(() => {
      expect(api.fetchQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'ERROR' }),
      );
    });
  });

  it('debounces the search term into one request', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useCases({ api, debounceMs: 10 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = api.fetchQueue.mock.calls.length;

    act(() => {
      result.current.setSearch('a');
      result.current.setSearch('ai');
      result.current.setSearch('patient');
    });

    await waitFor(() => {
      expect(api.fetchQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'patient' }),
      );
    });
    // One extra request for the settled term, not one per keystroke.
    expect(api.fetchQueue.mock.calls.length - before).toBeLessThanOrEqual(2);
  });

  it('exposes an error message when the queue cannot load', async () => {
    const api = fakeApi({
      fetchQueue: vi.fn(async () => { throw new Error('Network down'); }),
    });
    const { result } = renderHook(() => useCases({ api }));

    await waitFor(() => expect(result.current.error).toBe('Network down'));
    expect(result.current.items).toEqual([]);
  });

  it('remove deletes the case and reloads the queue', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useCases({ api }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = api.fetchQueue.mock.calls.length;

    let outcome;
    await act(async () => { outcome = await result.current.remove(1); });

    expect(api.deleteXray).toHaveBeenCalledWith(1);
    expect(outcome.ok).toBe(true);
    expect(api.fetchQueue.mock.calls.length).toBeGreaterThan(before);
  });

  it('remove surfaces a refusal without dropping the row locally', async () => {
    const api = fakeApi({
      deleteXray: vi.fn(async () => { throw new Error('a signed referral cannot be deleted'); }),
    });
    const { result } = renderHook(() => useCases({ api }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome;
    await act(async () => { outcome = await result.current.remove(2); });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/signed referral/);
    expect(result.current.items).toHaveLength(3);
  });

  it('retry calls the api and reloads the queue', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useCases({ api }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = api.fetchQueue.mock.calls.length;

    await act(async () => { await result.current.retry(3); });

    expect(api.retryXray).toHaveBeenCalledWith(3);
    expect(api.fetchQueue.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('useCaseDetail', () => {
  const CASE = {
    id: 1,
    patient_name: 'Patient One',
    status: 'PROCESSED',
    detections: [
      { id: 10, source: 'detect', needs_extraction: true, is_third_molar: true },
      { id: 11, source: 'detect', needs_extraction: false },
      { id: 12, source: 'segment', polygon: [[0, 0], [1, 1], [2, 2]] },
      { id: 13, source: 'hier', is_third_molar: true },
    ],
    referral: { prescription_text: 'Extract 38.' },
  };

  function detailApi(overrides = {}) {
    return {
      fetchXray: vi.fn(async () => CASE),
      approveCase: vi.fn(async () => ({ marked_for_extraction: 1 })),
      ...overrides,
    };
  }

  it('loads the case for the given id', async () => {
    const api = detailApi();
    const { result } = renderHook(() => useCaseDetail({ api, xrayId: 1 }));

    await waitFor(() => expect(result.current.caseData?.id).toBe(1));
    expect(api.fetchXray).toHaveBeenCalledWith(1);
  });

  it('does not fetch when no id is given', () => {
    const api = detailApi();
    renderHook(() => useCaseDetail({ api, xrayId: null }));

    expect(api.fetchXray).not.toHaveBeenCalled();
  });

  it('splits detections by source model', async () => {
    const { result } = renderHook(() => useCaseDetail({ api: detailApi(), xrayId: 1 }));

    await waitFor(() => expect(result.current.caseData).toBeTruthy());
    expect(result.current.toothDetections.map((d) => d.id)).toEqual([10, 11]);
    expect(result.current.segDetections.map((d) => d.id)).toEqual([12]);
    expect(result.current.hierDetections.map((d) => d.id)).toEqual([13]);
    expect(result.current.maskCount).toBe(1);
  });

  it('seeds extraction ticks from stored decisions', async () => {
    const { result } = renderHook(() => useCaseDetail({ api: detailApi(), xrayId: 1 }));

    await waitFor(() => expect(result.current.caseData).toBeTruthy());
    expect(result.current.extractionIds).toEqual([10]);
  });

  it('seeds the prescription from an existing referral', async () => {
    const { result } = renderHook(() => useCaseDetail({ api: detailApi(), xrayId: 1 }));

    await waitFor(() => expect(result.current.prescriptionText).toBe('Extract 38.'));
  });

  it('toggles an extraction tick on and off', async () => {
    const { result } = renderHook(() => useCaseDetail({ api: detailApi(), xrayId: 1 }));
    await waitFor(() => expect(result.current.caseData).toBeTruthy());

    act(() => { result.current.toggleExtraction(11); });
    expect(result.current.extractionIds).toContain(11);

    act(() => { result.current.toggleExtraction(11); });
    expect(result.current.extractionIds).not.toContain(11);
  });

  // approve() no longer takes a doctorName: the signing clinician comes from the
  // authenticated session server-side, so a decision is what the client chooses.
  it('rejects approval without a decision', async () => {
    const api = detailApi();
    const { result } = renderHook(() => useCaseDetail({ api, xrayId: 1 }));
    await waitFor(() => expect(result.current.caseData).toBeTruthy());

    let outcome;
    await act(async () => {
      outcome = await result.current.approve({
        signature: 'data:image/png;base64,AAA',
      });
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/decision/i);
    expect(api.approveCase).not.toHaveBeenCalled();
  });

  it('rejects approval without a signature', async () => {
    const api = detailApi();
    const { result } = renderHook(() => useCaseDetail({ api, xrayId: 1 }));
    await waitFor(() => expect(result.current.caseData).toBeTruthy());

    act(() => { result.current.setDecision('EXTRACT'); });

    let outcome;
    await act(async () => {
      outcome = await result.current.approve({ signature: '' });
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/sign/i);
    expect(api.approveCase).not.toHaveBeenCalled();
  });

  it('refuses "no action needed" alongside teeth marked for extraction', async () => {
    const api = detailApi();
    const { result } = renderHook(() => useCaseDetail({ api, xrayId: 1 }));
    await waitFor(() => expect(result.current.caseData).toBeTruthy());

    // Detection 10 arrives already ticked from the fixture.
    expect(result.current.extractionIds).toContain(10);
    act(() => { result.current.setDecision('NO_ACTION_NEEDED'); });

    let outcome;
    await act(async () => {
      outcome = await result.current.approve({
        signature: 'data:image/png;base64,AAA',
      });
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no action needed/i);
    expect(api.approveCase).not.toHaveBeenCalled();
  });

  it('approves with the decision and the ticked extraction ids', async () => {
    const api = detailApi();
    const { result } = renderHook(() => useCaseDetail({ api, xrayId: 1 }));
    await waitFor(() => expect(result.current.caseData).toBeTruthy());

    act(() => { result.current.setDecision('EXTRACT'); });

    let outcome;
    await act(async () => {
      outcome = await result.current.approve({
        signature: 'data:image/png;base64,AAA',
      });
    });

    expect(outcome.ok).toBe(true);
    expect(api.approveCase).toHaveBeenCalledWith(expect.objectContaining({
      xrayId: 1, decision: 'EXTRACT', extractionIds: [10],
    }));
    // The clinician's identity is never sent from the client.
    expect(api.approveCase.mock.calls[0][0]).not.toHaveProperty('doctorName');
  });
});
